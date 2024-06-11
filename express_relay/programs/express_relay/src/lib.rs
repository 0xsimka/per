pub mod error;
pub mod state;
pub mod utils;

use anchor_lang::{prelude::*, system_program::{System, create_account, CreateAccount}};
use anchor_lang::{AccountsClose, solana_program::sysvar::instructions as tx_instructions};
use solana_program::{hash, clock::Clock, serialize_utils::read_u16, sysvar::instructions::{load_current_index_checked, load_instruction_at_checked}};
use anchor_syn::codegen::program::common::sighash;
use anchor_spl::token::{self, TokenAccount, Token, Mint, Transfer as SplTransfer, CloseAccount, ID as SPL_TOKEN_PROGRAM_ID};
use anchor_spl::associated_token::{Create, create, ID as SPL_ASSOCIATED_TOKEN_ACCOUNT_ID};
use crate::{
    error::ExpressRelayError,
    state::*,
    utils::*,
};
use std::str::FromStr;

declare_id!("AJ9QckBqWJdz5RAxpMi2P83q6R7y5xZ2yFxCAYr3bg3N");

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
pub fn validate_signature(
    sysvar_ixs: &UncheckedAccount,
    data: Box<PermissionArgs>,
    protocol_key: Pubkey,
    user_key: Pubkey,
    opportunity_adapter_args: Option<OpportunityAdapterArgsWithMints>,
) -> Result<()> {
    let bid_amount = data.bid_amount;
    let permission_id = data.permission_id;
    let valid_until = data.valid_until;

    let timestamp = Clock::get()?.unix_timestamp as u64;
    if timestamp > valid_until {
        return err!(ExpressRelayError::SignatureExpired)
    }

    let index_permission = load_current_index_checked(sysvar_ixs)?;
    let ix = load_instruction_at_checked((index_permission+1) as usize, sysvar_ixs)?;

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
    verify_ed25519_ix(&ix, &user_key.to_bytes(), digest.as_ref(), &data.signature)?;

    Ok(())
}

#[program]
pub mod express_relay {
    use anchor_lang::Discriminator;

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, data: InitializeArgs) -> Result<()> {
        validate_fee_split(data.split_protocol_default)?;
        validate_fee_split(data.split_relayer)?;

        let express_relay_metadata_data = &mut ctx.accounts.express_relay_metadata.load_init()?;
        // ctx.accounts.express_relay_metadata.bump = ctx.bumps.express_relay_metadata;
        express_relay_metadata_data.admin = *ctx.accounts.admin.key;
        express_relay_metadata_data.relayer_signer = *ctx.accounts.relayer_signer.key;
        express_relay_metadata_data.relayer_fee_receiver = *ctx.accounts.relayer_fee_receiver.key;
        express_relay_metadata_data.split_protocol_default = data.split_protocol_default;
        express_relay_metadata_data.split_relayer = data.split_relayer;

        Ok(())
    }

    pub fn set_relayer(ctx: Context<SetRelayer>, _data: SetRelayerArgs) -> Result<()> {
        let express_relay_metadata_data = &mut ctx.accounts.express_relay_metadata.load_mut()?;

        express_relay_metadata_data.relayer_signer = *ctx.accounts.relayer_signer.key;
        express_relay_metadata_data.relayer_fee_receiver = *ctx.accounts.relayer_fee_receiver.key;

        Ok(())
    }

    pub fn set_splits(ctx: Context<SetSplits>, data: SetSplitsArgs) -> Result<()> {
        validate_fee_split(data.split_protocol_default)?;
        validate_fee_split(data.split_relayer)?;

        let express_relay_metadata_data = &mut ctx.accounts.express_relay_metadata.load_mut()?;

        express_relay_metadata_data.split_protocol_default = data.split_protocol_default;
        express_relay_metadata_data.split_relayer = data.split_relayer;

        Ok(())
    }

    pub fn set_protocol_split(ctx: Context<SetProtocolSplit>, data: SetProtocolSplitArgs) -> Result<()> {
        validate_fee_split(data.split_protocol)?;

        ctx.accounts.protocol_config.split = data.split_protocol;

        Ok(())
    }

    pub fn permission<'info>(ctx: Context<'_, '_, '_, 'info, Permission<'info>>, data: Box<PermissionArgs>) -> Result<()> {
        let relayer_signer = &ctx.accounts.relayer_signer;
        let permission = &ctx.accounts.permission;
        let protocol = &ctx.accounts.protocol;
        let sysvar_ixs = &ctx.accounts.sysvar_instructions;
        let system_program = &ctx.accounts.system_program;

        // check that current permissioning ix is first (TODO: this may be only relevant if we are checking no relayer_signer in future ixs)
        let index_permission = load_current_index_checked(sysvar_ixs)?;
        if index_permission != 0 {
            return err!(ExpressRelayError::PermissioningOutOfOrder)
        }

        // check that no intermediate instructions use relayer_signer
        let num_instructions = read_u16(&mut 0, &sysvar_ixs.data.borrow()).map_err(|_| ProgramError::InvalidInstructionData)?;
        // TODO: do we need to do a checked_sub/saturating_sub here?
        let last_ix_index = num_instructions - 1;
        for index in 1..last_ix_index {
            let ix = load_instruction_at_checked(index as usize, sysvar_ixs)?;
            // TODO: we are going to have to figure out security here, preventing relayer_signer from signing for bad ixs
            // other than maintaining a sanctioned pubkey list? maybe instead just have a whitelist of programs that relayer signer can be in?
            // // only opportunity adapter allowed to use relayer signer as an account
            // if ix.program_id != OPPORTUNITY_ADAPTER_PROGRAM_ID {
            //     if ix.accounts.iter().any(|acc| acc.pubkey == *relayer_signer.key) {
            //         return err!(ExpressRelayError::RelayerSignerUsedElsewhere)
            //     }
            // }
        }

        // check that last instruction is depermission, with matching permission pda
        let ix_depermission = load_instruction_at_checked(last_ix_index as usize, sysvar_ixs)?;
        // anchor discriminator comes from the hash of "{namespace}:{name}" https://github.com/coral-xyz/anchor/blob/2a07d841c65d6f303aa9c2b0c68a6e69c4739aab/lang/syn/src/codegen/program/common.rs#L9-L23
        let program_equal = ix_depermission.program_id == *ctx.program_id;
        // TODO: can we make this matching permission accounts check more robust (e.g. using account names in addition, to not rely on ordering alone)?
        let matching_permission_accounts = ix_depermission.accounts[1].pubkey == permission.key();
        let expected_discriminator = sighash("global", "depermission");
        let matching_discriminator = ix_depermission.data[0..8] == expected_discriminator;
        let proper_depermissioning = program_equal && matching_permission_accounts && matching_discriminator;
        if !proper_depermissioning {
            return err!(ExpressRelayError::PermissioningOutOfOrder)
        }

        // check that permission account matches permission in depermission
        assert_eq!(permission.key(), ix_depermission.accounts[1].pubkey, "Permission account does not match permission in depermission instruction");
        // check that relayer_signer matches relayer_signer in depermission
        assert_eq!(relayer_signer.key(), ix_depermission.accounts[0].pubkey, "Relayer signer account does not match relayer signer in depermission instruction");

        let permission_data = &mut permission.load_init()?;
        permission_data.balance = permission.to_account_info().lamports();
        permission_data.bid_amount = data.bid_amount;

        let opportunity_adapter_args;

        match data.clone().opportunity_adapter_args {
            Some(args) => {
                permission_data.opportunity_adapter = 1;

                let user = &ctx.remaining_accounts[0];
                let express_relay_authority = &ctx.remaining_accounts[1];
                let token_program = &ctx.remaining_accounts[2];
                let associated_token_program = &ctx.remaining_accounts[3];

                // validate express_relay_authority
                let (pda_express_relay_authority, bump_express_relay_authority) = Pubkey::find_program_address(&[SEED_AUTHORITY], ctx.program_id);
                assert_eq!(pda_express_relay_authority, express_relay_authority.key());

                // validate the token_program
                assert_eq!(token_program.key(), SPL_TOKEN_PROGRAM_ID);

                // validate the associated_token_program
                assert_eq!(associated_token_program.key(), SPL_ASSOCIATED_TOKEN_ACCOUNT_ID);

                let remaining_accounts = &ctx.remaining_accounts[4..].iter().map(|acc| acc.to_account_info()).collect::<Vec<_>>();

                let sell_tokens = args.sell_tokens;
                let buy_tokens = args.buy_tokens;
                let mut sell_token_amounts: Vec<TokenAmount> = sell_tokens.iter().map(|x| TokenAmount { mint: Pubkey::default(), amount: *x }).collect();
                let mut buy_token_amounts: Vec<TokenAmount> = buy_tokens.iter().map(|x| TokenAmount { mint: Pubkey::default(), amount: *x }).collect();

                let n_sell_tokens = sell_tokens.len();
                let expected_changes: Vec<u64> = sell_tokens.iter().chain(buy_tokens.iter()).map(|x| *x).collect();
                assert_eq!(expected_changes.len() * 4, remaining_accounts.len());

                // TODO: make this offset determination programmatic in the future
                let offset_accounts_check_token_balances: usize = 14;
                assert_eq!(remaining_accounts.len() + offset_accounts_check_token_balances, ix_depermission.accounts.len());

                for (i, expected_change) in expected_changes.iter().enumerate() {
                    let mint_acc = &remaining_accounts[i*4];
                    let ta_user_acc = &remaining_accounts[i * 4 + 1];
                    let token_expectation_acc = &remaining_accounts[i * 4 + 2];
                    let ta_relayer_acc = &remaining_accounts[i * 4 + 3];

                    // validate the ta_user_acc and the mint acc
                    let mut mint_buf = &mint_acc.try_borrow_data()?[..];
                    let _mint_data = Mint::try_deserialize(&mut mint_buf)?;
                    let ta_user_data = TokenAccount::try_deserialize(&mut &ta_user_acc.try_borrow_data()?[..])?;
                    assert_eq!(ta_user_data.mint, mint_acc.key());
                    assert_eq!(ta_user_data.owner, user.key());

                    // validate the ta_relayer_acc is the ata of the relayer
                    let (ata_relayer_key, _) = Pubkey::find_program_address(
                        &[
                            &relayer_signer.key.to_bytes(),
                            &token_program.key.to_bytes(),
                            &mint_acc.key.to_bytes(),
                        ],
                        associated_token_program.key
                    );
                    assert_eq!(ata_relayer_key, ta_relayer_acc.key());

                    // check if the relayer token account data exists, if not create it and initialize it
                    if ta_relayer_acc.lamports() == 0 {
                        // create the token_expectation_acc
                        let cpi_accounts_create_token_account = Create {
                            payer: relayer_signer.to_account_info().clone(),
                            associated_token: ta_relayer_acc.clone(),
                            authority: relayer_signer.to_account_info().clone(),
                            mint: mint_acc.clone(),
                            system_program: system_program.to_account_info().clone(),
                            token_program: token_program.to_account_info().clone(),
                        };
                        let cpi_program = associated_token_program.to_account_info();
                        create(
                            CpiContext::new(
                                cpi_program,
                                cpi_accounts_create_token_account
                            )
                        )?;
                    }

                    // validate the ta_relayer_acc
                    let ta_relayer_data = TokenAccount::try_deserialize(&mut &ta_relayer_acc.try_borrow_data()?[..])?;
                    assert_eq!(ta_relayer_data.mint, mint_acc.key());
                    assert_eq!(ta_relayer_data.owner, relayer_signer.key());

                    // validate the address of the token_expectation_acc
                    let (pda_token_expectation, bump_token_expectation) = Pubkey::find_program_address(&[SEED_TOKEN_EXPECTATION, user.key().as_ref(), mint_acc.key().as_ref()], ctx.program_id);
                    assert_eq!(pda_token_expectation, token_expectation_acc.key());
                    assert_eq!(token_expectation_acc.lamports(), 0);

                    let discriminator_token_expectation = TokenExpectation::discriminator();

                    if token_expectation_acc.lamports() == 0 {
                        // create the token_expectation_acc
                        let cpi_acounts_create_account = CreateAccount {
                            from: relayer_signer.to_account_info().clone(),
                            to: token_expectation_acc.clone(),
                        };
                        let space = RESERVE_TOKEN_EXPECTATION;
                        let lamports = Rent::default().minimum_balance(space).max(1);
                        let cpi_program = system_program.to_account_info();
                        create_account(
                            CpiContext::new_with_signer(
                                cpi_program,
                                cpi_acounts_create_account,
                                &[
                                    &[
                                        SEED_TOKEN_EXPECTATION,
                                        user.key().as_ref(),
                                        mint_acc.key().as_ref(),
                                        &[bump_token_expectation]
                                    ]
                                ]
                            ),
                            lamports,
                            space as u64,
                            ctx.program_id
                        )?;

                        // initialize the token_expectation_acc discriminator
                        discriminator_token_expectation.serialize(&mut &mut token_expectation_acc.data.borrow_mut()[..8])?;
                    }

                    // check that the accounts in the later instruction match the accounts specified in this instruction
                    let mint_acc_check_token_balances = &ix_depermission.accounts[offset_accounts_check_token_balances + i * 4];
                    assert_eq!(mint_acc_check_token_balances.pubkey, mint_acc.key());
                    let ta_user_acc_check_token_balances = &ix_depermission.accounts[offset_accounts_check_token_balances + i * 4 + 1];
                    assert_eq!(ta_user_acc_check_token_balances.pubkey, ta_user_acc.key());
                    let token_expectation_acc_check_token_balances = &ix_depermission.accounts[offset_accounts_check_token_balances + i * 4 + 2];
                    assert_eq!(token_expectation_acc_check_token_balances.pubkey, token_expectation_acc.key());
                    let ta_relayer_acc_check_token_balances = &ix_depermission.accounts[offset_accounts_check_token_balances + i * 4 + 3];
                    assert_eq!(ta_relayer_acc_check_token_balances.pubkey, ta_relayer_acc.key());

                    let token_expectation_data = &mut TokenExpectation::try_deserialize(&mut &token_expectation_acc.try_borrow_mut_data()?[..])?;

                    let tokens = ta_user_data.amount;
                    if i < n_sell_tokens {
                        sell_token_amounts[i].mint = mint_acc.key();

                        // transfer tokens to the relayer ata
                        let cpi_accounts = SplTransfer {
                            from: ta_user_acc.clone(),
                            to: ta_relayer_acc.clone(),
                            authority: express_relay_authority.to_account_info().clone(),
                        };
                        let cpi_program = token_program.to_account_info();
                        token::transfer(
                            CpiContext::new_with_signer(
                                cpi_program,
                                cpi_accounts,
                                &[
                                    &[
                                        SEED_AUTHORITY,
                                        &[bump_express_relay_authority]
                                    ]
                                ]),
                            tokens
                        )?;

                        token_expectation_data.balance_post_expected = token_expectation_data.balance_post_expected.checked_add(tokens).unwrap();

                        token_expectation_data.balance_post_expected = token_expectation_data.balance_post_expected.checked_sub(*expected_change).unwrap();
                        token_expectation_data.sell_token = true;
                    } else {
                        buy_token_amounts[i - n_sell_tokens].mint = mint_acc.key();

                        token_expectation_data.balance_post_expected = token_expectation_data.balance_post_expected.checked_add(*expected_change).unwrap();
                        token_expectation_data.sell_token = false;
                    }

                    let token_expectation_data_with_discriminator = (discriminator_token_expectation, token_expectation_data.clone());
                    token_expectation_data_with_discriminator.serialize(&mut *token_expectation_acc.data.borrow_mut())?;
                }

                opportunity_adapter_args = Some(OpportunityAdapterArgsWithMints {
                    sell_token_amounts,
                    buy_token_amounts,
                })
            }

            None => {
                opportunity_adapter_args = None;
            }
        }

        let user_key = ix_depermission.accounts[2].pubkey;

        validate_signature(sysvar_ixs, data, protocol.key(), user_key, opportunity_adapter_args)?;

        Ok(())
    }

    pub fn depermission<'info>(ctx: Context<'_, '_, 'info, 'info, Depermission<'info>>) -> Result<()> {
        let relayer_signer = &ctx.accounts.relayer_signer;
        msg!("relayer signer {:p}", relayer_signer);
        let permission = &ctx.accounts.permission;
        let protocol_config = &ctx.accounts.protocol_config;
        let express_relay_metadata = &ctx.accounts.express_relay_metadata;
        let protocol_fee_receiver = &ctx.accounts.protocol_fee_receiver;
        let relayer_fee_receiver = &ctx.accounts.relayer_fee_receiver;

        let wsol_mint = &ctx.accounts.wsol_mint;
        let wsol_ta_user = &ctx.accounts.wsol_ta_user;
        let wsol_ta_express_relay = &ctx.accounts.wsol_ta_express_relay;
        let express_relay_authority = &ctx.accounts.express_relay_authority;
        let token_program = &ctx.accounts.token_program;

        let permission_data = permission.load()?;
        let bid_amount = permission_data.bid_amount;
        let opportunity_adapter = permission_data.opportunity_adapter;
        drop(permission_data);

        let express_relay_metadata_data = express_relay_metadata.load()?;
        let split_protocol_default = express_relay_metadata_data.split_protocol_default;
        let split_relayer = express_relay_metadata_data.split_relayer;
        drop(express_relay_metadata_data);

        if opportunity_adapter != 0 {
            let remaining_accounts = ctx.remaining_accounts;

            let mut token_expectation_accs = vec![];

            for i in 0..remaining_accounts.len()/4 {
                // TODO: if we aren't doing revalidation, do we need the mint?
                let _mint_acc = &remaining_accounts[i * 4];
                let ta_user_acc = &remaining_accounts[i * 4 + 1];
                let token_expectation_acc = &remaining_accounts[i * 4 + 2];
                let ta_relayer_acc = &remaining_accounts[i * 4 + 3];

                let ta_relayer_data = TokenAccount::try_deserialize(&mut &ta_relayer_acc.try_borrow_data()?[..])?;
                let token_expectation_data = TokenExpectation::try_deserialize(&mut &token_expectation_acc.try_borrow_data()?[..])?;

                // TODO: do we need to really do revalidation here...? conceivable in theory someone uses this ix without the initialization ix, but really?

                if token_expectation_data.balance_post_expected > ta_relayer_data.amount {
                    return err!(ExpressRelayError::TokenExpectationNotMet);
                }

                let cpi_accounts = SplTransfer {
                    from: ta_relayer_acc.clone(),
                    to: ta_user_acc.clone(),
                    authority: relayer_signer.to_account_info().clone(),
                };
                // TODO: how to handle this if relayer_signer were to receive SPL tokens? this shouldn't happen usually, but could (e.g. airdrops, mistaken sends, etc.)
                let tokens = token_expectation_data.balance_post_expected;
                let cpi_program = token_program.to_account_info();
                token::transfer(
                    CpiContext::new(cpi_program, cpi_accounts),
                    tokens
                )?;

                token_expectation_accs.push(token_expectation_acc);
            }

            for token_expectation_acc in token_expectation_accs.iter() {
                let token_expectation_acc_to_close: Account<TokenExpectation> = Account::try_from(token_expectation_acc)?;
                let _ = token_expectation_acc_to_close.close(relayer_signer.to_account_info());
            }
        }

        let rent_owed_relayer_signer = wsol_ta_express_relay.to_account_info().lamports();

        handle_wsol_transfer(
            wsol_ta_user,
            wsol_ta_express_relay,
            express_relay_authority,
            token_program,
            ctx.bumps.express_relay_authority,
            permission,
            wsol_mint,
            ctx.bumps.wsol_ta_express_relay
        )?;

        // if permission.to_account_info().lamports() < permission.balance.saturating_add(permission.bid_amount) {
        //     return err!(ExpressRelayError::BidNotMet)
        // }

        let split_protocol: u64;
        let protocol_config_account_info = protocol_config.to_account_info();
        if protocol_config_account_info.data_len() > 0 {
            let account_data = &mut &**protocol_config_account_info.try_borrow_data()?;
            let protocol_config_data = ConfigProtocol::try_deserialize(account_data)?;
            split_protocol = protocol_config_data.split;
        } else {
            split_protocol = split_protocol_default;
        }

        let fee_protocol = bid_amount * split_protocol / FEE_SPLIT_PRECISION;
        if fee_protocol > bid_amount {
            return err!(ExpressRelayError::FeesTooHigh);
        }
        let fee_relayer = bid_amount.saturating_sub(fee_protocol) * split_relayer / FEE_SPLIT_PRECISION;
        if fee_relayer.checked_add(fee_protocol).unwrap() > bid_amount {
            return err!(ExpressRelayError::FeesTooHigh);
        }

        transfer_lamports(&permission.to_account_info(), &relayer_signer.to_account_info(), rent_owed_relayer_signer)?;
        transfer_lamports(&permission.to_account_info(), &protocol_fee_receiver.to_account_info(), fee_protocol)?;
        transfer_lamports(&permission.to_account_info(), &relayer_fee_receiver.to_account_info(), fee_relayer)?;
        // send the remaining balance from the bid to the express relay metadata account
        transfer_lamports(&permission.to_account_info(), &express_relay_metadata.to_account_info(), bid_amount.saturating_sub(fee_protocol).saturating_sub(fee_relayer))?;

        Ok(())
    }
}








#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct InitializeArgs {
    pub split_protocol_default: u64,
    pub split_relayer: u64
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = RESERVE_EXPRESS_RELAY_METADATA, seeds = [SEED_METADATA], bump)]
    pub express_relay_metadata: AccountLoader<'info, ExpressRelayMetadata>,
    /// CHECK: this is just the PK for the admin to sign from
    pub admin: UncheckedAccount<'info>,
    /// CHECK: this is just the PK for the relayer to sign from
    pub relayer_signer: UncheckedAccount<'info>,
    /// CHECK: this is just a PK for the relayer to receive fees at
    pub relayer_fee_receiver: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct SetRelayerArgs {}

#[derive(Accounts)]
pub struct SetRelayer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_METADATA], bump, has_one = admin)]
    pub express_relay_metadata: AccountLoader<'info, ExpressRelayMetadata>,
    /// CHECK: this is just the PK for the relayer to sign from
    pub relayer_signer: UncheckedAccount<'info>,
    /// CHECK: this is just a PK for the relayer to receive fees at
    pub relayer_fee_receiver: UncheckedAccount<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct SetSplitsArgs {
    pub split_protocol_default: u64,
    pub split_relayer: u64,
}

#[derive(Accounts)]
pub struct SetSplits<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_METADATA], bump, has_one = admin)]
    pub express_relay_metadata: AccountLoader<'info, ExpressRelayMetadata>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct SetProtocolSplitArgs {
    pub split_protocol: u64,
}

#[derive(Accounts)]
pub struct SetProtocolSplit<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = RESERVE_EXPRESS_RELAY_CONFIG_PROTOCOL, seeds = [SEED_CONFIG_PROTOCOL, protocol.key().as_ref()], bump)]
    pub protocol_config: Account<'info, ConfigProtocol>,
    #[account(seeds = [SEED_METADATA], bump, has_one = admin)]
    pub express_relay_metadata: AccountLoader<'info, ExpressRelayMetadata>,
    /// CHECK: this is just the protocol fee receiver PK
    pub protocol: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Debug)]
pub struct PermissionArgs {
    // TODO: maybe add bid_id back? depending on size constraints
    // pub bid_id: [u8; 16],
    pub permission_id: [u8; 32],
    pub signature: [u8; 64],
    pub valid_until: u64,
    pub bid_amount: u64,
    pub opportunity_adapter_args: Option<OpportunityAdapterArgs>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Debug)]
pub struct OpportunityAdapterArgs {
    pub sell_tokens: Vec<u64>,
    pub buy_tokens: Vec<u64>,
}

#[derive(Accounts)]
#[instruction(data: Box<PermissionArgs>)]
pub struct Permission<'info> {
    #[account(mut)]
    pub relayer_signer: Signer<'info>,
    #[account(
        init,
        payer = relayer_signer,
        space = RESERVE_PERMISSION,
        seeds = [SEED_PERMISSION, protocol.key().as_ref(), &data.permission_id],
        bump,
    )]
    pub permission: AccountLoader<'info, PermissionMetadata>,
    /// CHECK: this is just the protocol program address
    pub protocol: UncheckedAccount<'info>,
    #[account(init, payer = relayer_signer, space = RESERVE_SIGNATURE_ACCOUNTING, seeds = [SEED_SIGNATURE_ACCOUNTING, &data.signature[..32], &data.signature[32..]], bump)]
    pub signature_accounting: AccountLoader<'info, SignatureAccounting>,
    pub system_program: Program<'info, System>,
    // TODO: https://github.com/solana-labs/solana/issues/22911
    /// CHECK: this is the sysvar instructions account
    #[account(address = tx_instructions::ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Depermission<'info> {
    #[account(mut)]
    pub relayer_signer: Signer<'info>,
    // TODO: upon close, should send funds to the program as opposed to the relayer signer--o/w relayer will get all "fat-fingered" fees
    /// CHECK: permission is correctly seeded, closed within the program
    #[account(mut, close = relayer_signer)]
    pub permission: AccountLoader<'info, PermissionMetadata>,
    /// CHECK: this is just the user account
    pub user: UncheckedAccount<'info>,
    /// CHECK: this is just the protocol program address
    pub protocol: UncheckedAccount<'info>,
    /// CHECK: don't care what this PDA looks like
    #[account(
        mut,
        seeds = [SEED_EXPRESS_RELAY_FEES],
        seeds::program = protocol.key(),
        bump
    )]
    pub protocol_fee_receiver: UncheckedAccount<'info>,
    /// CHECK: this is just a PK for the relayer to receive fees at
    #[account(mut)]
    pub relayer_fee_receiver: UncheckedAccount<'info>,
    /// CHECK: this cannot be checked against ConfigProtocol bc it may not be initialized bc anchor :(
    #[account(seeds = [SEED_CONFIG_PROTOCOL, protocol.key().as_ref()], bump)]
    pub protocol_config: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_METADATA], bump, has_one = relayer_signer, has_one = relayer_fee_receiver)]
    pub express_relay_metadata: AccountLoader<'info, ExpressRelayMetadata>,
    #[account(constraint = wsol_mint.key() == Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap())]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = wsol_mint, token::authority = user)]
    pub wsol_ta_user: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = relayer_signer,
        seeds = [b"ata", wsol_mint.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = wsol_ta_express_relay
    )]
    pub wsol_ta_express_relay: Box<Account<'info, TokenAccount>>,
    /// CHECK: This is an empty PDA, just used for signing
    #[account(seeds = [SEED_AUTHORITY], bump)]
    pub express_relay_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
