pub mod error;
pub mod state;
pub mod utils;

use borsh::{BorshSerialize, BorshDeserialize};
use anchor_lang::prelude::*;
use anchor_lang::{solana_program::sysvar::instructions as tx_instructions, system_program::{create_account, CreateAccount}, AccountsClose};
use solana_program::{hash, sysvar::instructions::{load_current_index_checked, load_instruction_at_checked}};
use anchor_syn::codegen::program::common::sighash;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};
use anchor_spl::associated_token::{AssociatedToken, Create, create};

use crate::{
    error::OpportunityAdapterError,
    state::*,
    utils::*,
};

declare_id!("Gn4yXmex2gAWUHJcFHy6iUkwPurka6uJMGPfzeZbKFFD");

#[inline(never)]
pub fn validate_signature(
    index: usize,
    sysvar_ixs: &UncheckedAccount,
    valid_until: u64,
    buy_tokens: Vec<TokenAmount>,
    sell_tokens: Vec<TokenAmount>,
    user_key: Pubkey,
    signature: [u8; 64]
) -> Result<()> {
    let n_buy_tokens = buy_tokens.len();
    let n_sell_tokens = sell_tokens.len();

    let n_buy_tokens_u8 = n_buy_tokens as u8;
    let n_sell_tokens_u8 = n_sell_tokens as u8;

    let timestamp = Clock::get()?.unix_timestamp as u64;

    if timestamp > valid_until {
        return err!(OpportunityAdapterError::SignatureExpired);
    }

    let ix = load_instruction_at_checked(index as usize, sysvar_ixs)?;

    let mut msg_vec = Vec::new();
    msg_vec.push(n_buy_tokens_u8);
    msg_vec.push(n_sell_tokens_u8);
    for buy_token in buy_tokens.iter() {
        msg_vec.extend_from_slice(&buy_token.mint.to_bytes());
        msg_vec.extend_from_slice(&buy_token.amount.to_le_bytes());
    }
    for sell_token in sell_tokens.iter() {
        msg_vec.extend_from_slice(&sell_token.mint.to_bytes());
        msg_vec.extend_from_slice(&sell_token.amount.to_le_bytes());
    }
    msg_vec.extend_from_slice(&user_key.to_bytes());
    msg_vec.extend_from_slice(&valid_until.to_le_bytes());

    let msg: &[u8] = &msg_vec;
    let digest = hash::hashv(&[msg]);
    verify_ed25519_ix(&ix, &user_key.to_bytes(), digest.as_ref(), &signature)?;

    Ok(())
}

#[program]
pub mod opportunity_adapter {
    use anchor_lang::Discriminator;

    use super::*;

    pub fn initialize_token_expectations<'info>(ctx: Context<'_, '_, '_, 'info, InitializeTokenExpectations<'info>>, data: InitializeTokenExpectationsArgs) -> Result<()> {
        let relayer = &ctx.accounts.relayer;
        let user = &ctx.accounts.user;
        let opportunity_adapter_authority = &ctx.accounts.opportunity_adapter_authority;
        let token_program = &ctx.accounts.token_program;
        let system_program = &ctx.accounts.system_program;
        let associated_token_program = &ctx.accounts.associated_token_program;
        let sysvar_ixs = &ctx.accounts.sysvar_instructions;
        let remaining_accounts = ctx.remaining_accounts;

        let index_init_token_expectations = load_current_index_checked(sysvar_ixs)?;

        // check that the (index_check_token_balances)th instruction matches check
        let index_check_token_balances = data.index_check_token_balances;
        assert!(index_check_token_balances > index_init_token_expectations);

        let ix_check_token_balances = load_instruction_at_checked(index_check_token_balances as usize, sysvar_ixs)?;
        let program_equal = ix_check_token_balances.program_id == *ctx.program_id;
        let matching_discriminator = ix_check_token_balances.data[0..8] == sighash("global", "check_token_balances");

        if !program_equal || !matching_discriminator {
            return err!(OpportunityAdapterError::NoTokenChecking);
        }

        let sell_tokens = data.sell_tokens;
        let buy_tokens = data.buy_tokens;
        let mut sell_token_amounts: Vec<TokenAmount> = sell_tokens.iter().map(|x| TokenAmount { mint: Pubkey::default(), amount: *x }).collect();
        let mut buy_token_amounts: Vec<TokenAmount> = buy_tokens.iter().map(|x| TokenAmount { mint: Pubkey::default(), amount: *x }).collect();

        let n_sell_tokens = sell_tokens.len();
        let expected_changes: Vec<u64> = sell_tokens.iter().chain(buy_tokens.iter()).map(|x| *x).collect();
        assert_eq!(expected_changes.len() * 4, remaining_accounts.len());

        // TODO: make this offset determination programmatic in the future
        let offset_accounts_check_token_balances: usize = 5;
        assert_eq!(remaining_accounts.len() + offset_accounts_check_token_balances, ix_check_token_balances.accounts.len());

        for (i, expected_change) in expected_changes.iter().enumerate() {
            let mint_acc = &remaining_accounts[i * 4];
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
                    &relayer.key.to_bytes(),
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
                    payer: relayer.to_account_info().clone(),
                    associated_token: ta_relayer_acc.clone(),
                    authority: relayer.to_account_info().clone(),
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
            assert_eq!(ta_relayer_data.owner, relayer.key());

            // validate the address of the token_expectation_acc
            let (pda_token_expectation, bump_token_expectation) = Pubkey::find_program_address(&[SEED_TOKEN_EXPECTATION, user.key().as_ref(), mint_acc.key().as_ref()], ctx.program_id);
            assert_eq!(pda_token_expectation, token_expectation_acc.key());
            assert_eq!(token_expectation_acc.lamports(), 0);

            let discriminator_token_expectation = TokenExpectation::discriminator();

            if token_expectation_acc.lamports() == 0 {
                // create the token_expectation_acc
                let cpi_acounts_create_account = CreateAccount {
                    from: relayer.to_account_info().clone(),
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
            let mint_acc_check_token_balances = &ix_check_token_balances.accounts[offset_accounts_check_token_balances + i * 4];
            assert_eq!(mint_acc_check_token_balances.pubkey, mint_acc.key());
            let ta_user_acc_check_token_balances = &ix_check_token_balances.accounts[offset_accounts_check_token_balances + i * 4 + 1];
            assert_eq!(ta_user_acc_check_token_balances.pubkey, ta_user_acc.key());
            let token_expectation_acc_check_token_balances = &ix_check_token_balances.accounts[offset_accounts_check_token_balances + i * 4 + 2];
            assert_eq!(token_expectation_acc_check_token_balances.pubkey, token_expectation_acc.key());
            let ta_relayer_acc_check_token_balances = &ix_check_token_balances.accounts[offset_accounts_check_token_balances + i * 4 + 3];
            assert_eq!(ta_relayer_acc_check_token_balances.pubkey, ta_relayer_acc.key());

            let token_expectation_data = &mut TokenExpectation::try_deserialize(&mut &token_expectation_acc.try_borrow_mut_data()?[..])?;

            let tokens = ta_user_data.amount;
            if i < n_sell_tokens {
                sell_token_amounts[i].mint = mint_acc.key();

                // transfer tokens to the relayer ata
                let cpi_accounts = SplTransfer {
                    from: ta_user_acc.clone(),
                    to: ta_relayer_acc.clone(),
                    authority: opportunity_adapter_authority.to_account_info().clone(),
                };
                let cpi_program = token_program.to_account_info();
                token::transfer(
                    CpiContext::new_with_signer(
                        cpi_program,
                        cpi_accounts,
                        &[
                            &[
                                SEED_AUTHORITY,
                                &[ctx.bumps.opportunity_adapter_authority]
                            ]
                        ]),
                    tokens
                )?;

                token_expectation_data.balance_post_expected = token_expectation_data.balance_post_expected.checked_add(tokens).unwrap();

                token_expectation_data.balance_post_expected = token_expectation_data.balance_post_expected.checked_sub(*expected_change).unwrap();
            } else {
                buy_token_amounts[i - n_sell_tokens].mint = mint_acc.key();

                token_expectation_data.balance_post_expected = token_expectation_data.balance_post_expected.checked_add(*expected_change).unwrap();
            }

            let token_expectation_data_with_discriminator = (discriminator_token_expectation, token_expectation_data.clone());
            token_expectation_data_with_discriminator.serialize(&mut *token_expectation_acc.data.borrow_mut())?;
        }

        // check that the instruction prior to checking token balances is signature validation
        validate_signature(
            (index_check_token_balances-1) as usize,
            sysvar_ixs,
            data.valid_until,
            buy_token_amounts,
            sell_token_amounts,
            user.key(),
            data.signature
        )?;

        Ok(())
    }

    pub fn check_token_balances<'info>(ctx: Context<'_, '_, 'info, 'info, CheckTokenBalances<'info>>) -> Result<()> {
        let relayer = &ctx.accounts.relayer;
        let relayer_rent_receiver = &ctx.accounts.relayer_rent_receiver;
        let token_program = &ctx.accounts.token_program;

        let remaining_accounts = ctx.remaining_accounts;

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
                return err!(OpportunityAdapterError::TokenExpectationNotMet);
            }

            let cpi_accounts = SplTransfer {
                from: ta_relayer_acc.clone(),
                to: ta_user_acc.clone(),
                authority: relayer.to_account_info().clone(),
            };
            // TODO: how to handle this if relayer_signer were to receive SPL tokens? this shouldn't happen usually, but could (e.g. airdrops, mistaken sends, etc.)
            let tokens = token_expectation_data.balance_post_expected;
            let cpi_program = token_program.to_account_info();
            token::transfer(
                CpiContext::new(cpi_program, cpi_accounts),
                tokens
            )?;

            // close the token_expectation account
            let token_expectation_acc_to_close: Account<TokenExpectation> = Account::try_from(token_expectation_acc)?;
            let _ = token_expectation_acc_to_close.close(relayer_rent_receiver.to_account_info());
        }

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Debug)]
pub struct InitializeTokenExpectationsArgs {
    pub sell_tokens: Vec<u64>,
    pub buy_tokens: Vec<u64>,
    pub index_check_token_balances: u16,
    pub valid_until: u64,
    pub signature: [u8; 64],
}

#[derive(Accounts)]
#[instruction(data: InitializeTokenExpectationsArgs)]
pub struct InitializeTokenExpectations<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    /// CHECK: this is just the PK of the user
    pub user: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = relayer, space = RESERVE_AUTHORITY, seeds = [SEED_AUTHORITY], bump)]
    pub opportunity_adapter_authority: Account<'info, Authority>,
    #[account(init, payer = relayer, space = RESERVE_SIGNATURE_ACCOUNTING, seeds = [SEED_SIGNATURE_ACCOUNTING, &data.signature[..32], &data.signature[32..]], bump)]
    pub signature_accounting: Account<'info, SignatureAccounting>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: this is the sysvar instructions account
    #[account(address = tx_instructions::ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CheckTokenBalances<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    // TODO: the issue that makes this account necessary: https://github.com/solana-labs/solana/issues/9711
    // TODO: do we need a separate relayer_rent_receiver? why can't we send rent right back to the relayer signer?
    /// CHECK: this is just a PK where the relayer receives fees.
    #[account(mut)]
    pub relayer_rent_receiver: UncheckedAccount<'info>,
    /// CHECK: this is just the PK of the user
    pub user: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}