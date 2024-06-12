use anchor_lang::{prelude::*, system_program::{CreateAccount, create_account}};
use solana_program::instruction::Instruction;
use solana_program::ed25519_program::ID as ED25519_ID;
use solana_program::{hash, clock::Clock};
use anchor_spl::token::{self, TokenAccount, Token, Mint, Transfer as SplTransfer, CloseAccount};
use solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use crate::{
    error::ExpressRelayError,
    state::*,
};

pub fn validate_fee_split(split: u64) -> Result<()> {
    if split > FEE_SPLIT_PRECISION {
        return err!(ExpressRelayError::InvalidFeeSplits);
    }
    Ok(())
}

pub fn validate_pda(
    seeds: &[&[u8]],
    program_id: &Pubkey,
    expected_key: Pubkey
) -> Result<u8> {
    // validate the address of signature accounting
    let (pda, bump) = Pubkey::find_program_address(seeds, program_id);
    assert_eq!(pda, expected_key);
    Ok(bump)
}

pub fn create_pda<'info>(
    pda: AccountInfo<'info>,
    from: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    seeds_with_bump: &[&[u8]],
    program_id: Pubkey,
    space: usize,
    discriminator: Option<[u8; 8]>,
) -> Result<()> {
    assert_eq!(pda.lamports(), 0);

    let cpi_acounts_create_account = CreateAccount {
        from: from,
        to: pda.clone(),
    };
    let lamports = Rent::default().minimum_balance(space).max(1);
    create_account(
        CpiContext::new_with_signer(
            system_program,
            cpi_acounts_create_account,
            &[seeds_with_bump]
        ),
        lamports,
        space as u64,
        &program_id
    )?;

    match discriminator {
        Some(discriminator) => {
            discriminator.serialize(&mut &mut pda.data.borrow_mut()[..8])?;
        },
        None => ()
    }

    Ok(())
}

pub fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> Result<()> {
    **from.try_borrow_mut_lamports()? -= amount;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

#[inline(never)]
pub fn handle_wsol_transfer<'info>(
    wsol_ta_user: &Account<'info, TokenAccount>,
    wsol_ta_express_relay: &Account<'info, TokenAccount>,
    express_relay_authority: &UncheckedAccount<'info>,
    token_program: &Program<'info, Token>,
    bump_express_relay_authority: u8,
    permission: &AccountLoader<'info, PermissionMetadata>,
    wsol_mint: &Account<'info, Mint>,
    bump_wsol_ta_express_relay: u8,
) -> Result<()> {
    let permission_data = permission.load()?;
    let bid_amount = permission_data.bid_amount;
    drop(permission_data);

    // wrapped sol transfer
    let cpi_accounts_transfer = SplTransfer {
        from: wsol_ta_user.to_account_info().clone(),
        to: wsol_ta_express_relay.to_account_info().clone(),
        authority: express_relay_authority.to_account_info().clone(),
    };
    let cpi_program_transfer = token_program.to_account_info();
    token::transfer(
        CpiContext::new_with_signer(
            cpi_program_transfer,
            cpi_accounts_transfer,
            &[
                &[
                    SEED_AUTHORITY,
                    &[bump_express_relay_authority]
                ]
            ]
        ),
        bid_amount
    )?;

    // close wsol_ta_express_relay to get the SOL
    let cpi_accounts_close = CloseAccount {
        account: wsol_ta_express_relay.to_account_info().clone(),
        destination: permission.to_account_info().clone(),
        authority: wsol_ta_express_relay.to_account_info().clone(),
    };
    let cpi_program_close = token_program.to_account_info();
    token::close_account(
        CpiContext::new_with_signer(
            cpi_program_close,
            cpi_accounts_close,
            &[
                &[
                    b"ata",
                    wsol_mint.key().as_ref(),
                    &[bump_wsol_ta_express_relay]
                ]
            ]
        )
    )?;

    Ok(())
}

#[inline(never)]
pub fn validate_and_extract_signature(
    sysvar_ixs: &UncheckedAccount,
    permission_id: [u8; 32],
    bid_amount: u64,
    valid_until: u64,
    protocol_key: Pubkey,
    user_key: Pubkey,
    opportunity_adapter_args: Option<OpportunityAdapterArgsWithMints>,
) -> Result<[u8; 64]> {
    let timestamp = Clock::get()?.unix_timestamp as u64;
    if timestamp > valid_until {
        return err!(ExpressRelayError::SignatureExpired)
    }

    let index_permission = load_current_index_checked(sysvar_ixs)?;
    let ix = load_instruction_at_checked((index_permission+1) as usize, sysvar_ixs)?;

    let signature: [u8; 64] = ix.data[48..48+64].try_into().unwrap();

    let mut msg_vec = Vec::new();

    msg_vec.extend_from_slice(&protocol_key.to_bytes());
    msg_vec.extend_from_slice(&permission_id);
    msg_vec.extend_from_slice(&user_key.to_bytes());
    msg_vec.extend_from_slice(&bid_amount.to_le_bytes());
    msg_vec.extend_from_slice(&valid_until.to_le_bytes());

    match opportunity_adapter_args {
        Some(args) => {
            let buy_tokens = args.buy_token_amounts;
            let sell_tokens = args.sell_token_amounts;

            let n_buy_tokens = buy_tokens.len() as u8;
            let n_sell_tokens = sell_tokens.len() as u8;

            msg_vec.push(n_buy_tokens);
            msg_vec.push(n_sell_tokens);
            for buy_token in buy_tokens.iter() {
                msg_vec.extend_from_slice(&buy_token.mint.to_bytes());
                msg_vec.extend_from_slice(&buy_token.amount.to_le_bytes());
            }
            for sell_token in sell_tokens.iter() {
                msg_vec.extend_from_slice(&sell_token.mint.to_bytes());
                msg_vec.extend_from_slice(&sell_token.amount.to_le_bytes());
            }
        }

        None => {}
    }
    let msg: &[u8] = &msg_vec;
    let digest = hash::hash(msg);
    verify_ed25519_ix(&ix, &user_key.to_bytes(), digest.as_ref())?;

    Ok(signature)
}

/// Verify Ed25519Program instruction fields
pub fn verify_ed25519_ix(ix: &Instruction, pubkey: &[u8], msg: &[u8]) -> Result<()> {
    if  ix.program_id       != ED25519_ID                   ||  // The program id we expect
        ix.accounts.len()   != 0                            ||  // With no context accounts
        ix.data.len()       != (16 + 64 + 32 + msg.len())       // And data of this size
    {
        return err!(ExpressRelayError::SignatureVerificationFailed);    // Otherwise, we can already throw err
    }

    check_ed25519_data(&ix.data, pubkey, msg)?;            // If that's not the case, check data

    Ok(())
}

/// Verify serialized Ed25519Program instruction data
pub fn check_ed25519_data(data: &[u8], pubkey: &[u8], msg: &[u8]) -> Result<()> {
    // According to this layout used by the Ed25519Program
    // https://github.com/solana-labs/solana-web3.js/blob/master/src/ed25519-program.ts#L33

    // "Deserializing" byte slices

    let num_signatures                  = &[data[0]];        // Byte  0
    let padding                         = &[data[1]];        // Byte  1
    let signature_offset                = &data[2..=3];      // Bytes 2,3
    let signature_instruction_index     = &data[4..=5];      // Bytes 4,5
    let public_key_offset               = &data[6..=7];      // Bytes 6,7
    let public_key_instruction_index    = &data[8..=9];      // Bytes 8,9
    let message_data_offset             = &data[10..=11];    // Bytes 10,11
    let message_data_size               = &data[12..=13];    // Bytes 12,13
    let message_instruction_index       = &data[14..=15];    // Bytes 14,15

    let data_pubkey                     = &data[16..16+32];  // Bytes 16..16+32
    let data_sig                        = &data[48..48+64];  // Bytes 48..48+64
    let data_msg                        = &data[112..];      // Bytes 112..end

    // Expected values

    let exp_public_key_offset:      u16 = 16; // 2*u8 + 7*u16
    let exp_signature_offset:       u16 = exp_public_key_offset + pubkey.len() as u16;
    let exp_message_data_offset:    u16 = exp_signature_offset + data_sig.len() as u16;
    let exp_num_signatures:          u8 = 1;
    let exp_message_data_size:      u16 = msg.len().try_into().unwrap();

    // Header and Arg Checks

    // Header
    if  num_signatures                  != &exp_num_signatures.to_le_bytes()        ||
        padding                         != &[0]                                     ||
        signature_offset                != &exp_signature_offset.to_le_bytes()      ||
        signature_instruction_index     != &u16::MAX.to_le_bytes()                  ||
        public_key_offset               != &exp_public_key_offset.to_le_bytes()     ||
        public_key_instruction_index    != &u16::MAX.to_le_bytes()                  ||
        message_data_offset             != &exp_message_data_offset.to_le_bytes()   ||
        message_data_size               != &exp_message_data_size.to_le_bytes()     ||
        message_instruction_index       != &u16::MAX.to_le_bytes()
    {
        return err!(ExpressRelayError::SignatureVerificationFailed);
    }

    // Arguments
    if  data_pubkey != pubkey   ||
        data_msg    != msg
    {
        return err!(ExpressRelayError::SignatureVerificationFailed);
    }

    Ok(())
}
