pub mod error;
pub mod state;

use anchor_lang::{prelude::*, system_program::System};
use anchor_spl::token::{
    self,
    Token,
    Transfer as SplTransfer
};
use express_relay::{
    state::{SEED_PERMISSION, PermissionMetadata},
    ID as EXPRESS_RELAY_PROGRAM_ID
};
use solana_program::clock::Clock;
use crate::state::*;
use crate::error::IntentSwapError;

declare_id!("SwAp6rvBWXdiWJ839GXdDitk8Y4M5UvBLhTZSZGcPS5");

pub fn fulfill_intent<'info>(
    intent_accounting: &mut IntentAccounting,
    token_program: &Program<'info, Token>,
    fulfiller: &Signer<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    data: IntentArgs,
) -> Result<()> {
    if data.deadline_permissionless < Clock::get()?.unix_timestamp as u64 {
        return err!(IntentSwapError::DeadlinePassed);
    }

    let n_sell_tokens = data.sell_token_amounts.len();
    let n_buy_tokens = data.buy_token_amounts.len();

    assert_eq!(remaining_accounts.len(), 3*n_sell_tokens + 3*n_buy_tokens);

    if !intent_accounting.initialized {
        intent_accounting.initialized = true;

        let mut sell_tokens = Vec::new();
        for i in 0..n_sell_tokens {
            let mint = &remaining_accounts[3*i];

            let requester_amount = data.sell_token_amounts[i].0;

            sell_tokens.push(TokenAmountFulfilled {
                mint: *mint.to_account_info().key,
                amount: requester_amount,
                fulfilled: 0,
            });
        }
        intent_accounting.sell_tokens = sell_tokens;

        let mut buy_tokens = Vec::new();
        for i in n_sell_tokens..(n_sell_tokens+n_buy_tokens) {
            let mint = &remaining_accounts[3*i];

            let requester_amount = data.buy_token_amounts[i].0;

            buy_tokens.push(TokenAmount {
                mint: *mint.to_account_info().key,
                amount: requester_amount,
            });
        }
        intent_accounting.buy_tokens = buy_tokens;
    } else {
        assert!(!intent_accounting.cancelled);
    }

    // TODO: check sigver of the signature

    let cpi_token_program = token_program.to_account_info();
    let fulfiller_acc_info = fulfiller.to_account_info();
    let mut max_perc_sold: u64 = 0;

    for i in 0..n_sell_tokens {
        let requester_ata = &remaining_accounts[3*i + 1];
        let fulfiller_ata = &remaining_accounts[3*i + 2];

        let requester_amount = data.sell_token_amounts[i].1;

        // TODO: validate the fill is valid given exchange rate (partial fills)
        assert!(requester_amount <= intent_accounting.sell_tokens[i].amount - intent_accounting.sell_tokens[i].fulfilled);
        max_perc_sold = max_perc_sold.max(requester_amount * 1_000_000 / intent_accounting.sell_tokens[i].amount);

        // transfer sell token from requester to fulfiller
        let cpi_accounts_sell = SplTransfer {
            from: requester_ata.to_account_info().clone(),
            to: fulfiller_ata.to_account_info().clone(),
            authority: fulfiller_acc_info.clone(), // TODO: fix
        };

        token::transfer(
            CpiContext::new(cpi_token_program.clone(), cpi_accounts_sell),
            requester_amount)?;
        intent_accounting.sell_tokens[i].fulfilled += requester_amount;
    }

    for i in n_sell_tokens..(n_sell_tokens+n_buy_tokens) {
        let requester_ata = &remaining_accounts[3*i + 1];
        let fulfiller_ata = &remaining_accounts[3*i + 2];

        let index = i - n_sell_tokens;
        let requester_amount = data.buy_token_amounts[index].1;

        let requester_perc = requester_amount * 1_000_000 / intent_accounting.buy_tokens[index].amount;
        assert!(requester_perc >= max_perc_sold);

        // transfer buy token from fulfiller to requester
        let cpi_accounts_buy = SplTransfer {
            from: fulfiller_ata.to_account_info().clone(),
            to: requester_ata.to_account_info().clone(),
            authority: fulfiller_ata.to_account_info().clone(), // TODO: fix
        };

        token::transfer(
            CpiContext::new(cpi_token_program.clone(), cpi_accounts_buy),
            requester_amount)?;
    }

    Ok(())
}

#[program]
pub mod intent_swap {
    use super::*;

    pub fn fulfill_intent_er<'info>(ctx: Context<'_, '_, '_, 'info, FulfillIntentER<'info>>, data: IntentArgs) -> Result<()> {
        fulfill_intent(&mut ctx.accounts.intent_accounting, &ctx.accounts.token_program, &ctx.accounts.fulfiller, ctx.remaining_accounts, data)
    }

    pub fn fulfill_intent_permissionless<'info>(ctx: Context<'_, '_, '_, 'info, FulfillIntentPermissionless<'info>>, data: IntentArgs) -> Result<()> {
        if data.deadline_er >= Clock::get()?.unix_timestamp as u64 {
            return err!(IntentSwapError::DeadlineERNotPassed);
        }

        fulfill_intent(&mut ctx.accounts.intent_accounting, &ctx.accounts.token_program, &ctx.accounts.fulfiller, ctx.remaining_accounts, data)
    }

    pub fn cancel_intent(ctx: Context<CancelIntent>, data: IntentArgs) -> Result<()> {
        // TODO: check sigver of the signature

        if !ctx.accounts.intent_accounting.initialized {
            ctx.accounts.intent_accounting.initialized = true;
        }

        ctx.accounts.intent_accounting.cancelled = true;

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Debug)]
pub struct IntentArgs {
    pub deadline_er: u64,
    pub deadline_permissionless: u64,
    pub signature: [u8; 64],
    pub sell_token_amounts: Vec<(u64, u64)>,
    pub buy_token_amounts: Vec<(u64, u64)>,
}

#[derive(Accounts)]
#[instruction(data: IntentArgs)]
pub struct FulfillIntentER<'info> {
    #[account(mut)]
    pub fulfiller: Signer<'info>,
    /// CHECK: this is just the account that made the intent
    pub requester: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer=fulfiller,
        space=RESERVE_INTENT_ACCOUNTING,
        seeds = [
            SEED_INTENT_ACCOUNTING,
            &data.signature[..32],
            &data.signature[32..]
        ],
        bump
    )]
    pub intent_accounting: Account<'info, IntentAccounting>,
    #[account(
        seeds = [
            SEED_PERMISSION,
            ID.as_ref(),
            &data.signature[..32] // TODO: make this more secure, use all of the signature
        ],
        bump,
        seeds::program = EXPRESS_RELAY_PROGRAM_ID
    )]
    pub permission: AccountLoader<'info, PermissionMetadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // extra accounts
    // for each sell token:
    //     0. sell token mint
    //     1. requester ata
    //     2. fulfiller ata
    // for each buy token:
    //     0. buy token mint
    //     1. requester ata
    //     2. fulfiller ata
}

#[derive(Accounts)]
#[instruction(data: IntentArgs)]
pub struct FulfillIntentPermissionless<'info> {
    #[account(mut)]
    pub fulfiller: Signer<'info>,
    /// CHECK: this is just the account that made the intent
    pub requester: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer=fulfiller,
        space=RESERVE_INTENT_ACCOUNTING,
        seeds = [
            SEED_INTENT_ACCOUNTING,
            &data.signature[..32],
            &data.signature[32..]
        ],
        bump
    )]
    pub intent_accounting: Account<'info, IntentAccounting>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // extra accounts
    // for each sell token:
    //     0. sell token mint
    //     1. requester ata
    //     2. fulfiller ata
    // for each buy token:
    //     0. buy token mint
    //     1. requester ata
    //     2. fulfiller ata
}

#[derive(Accounts)]
#[instruction(data: IntentArgs)]
pub struct CancelIntent<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        init_if_needed,
        payer=requester,
        space=RESERVE_INTENT_ACCOUNTING,
        seeds = [
            SEED_INTENT_ACCOUNTING,
            &data.signature[..32],
            &data.signature[32..]
        ],
        bump
    )]
    pub intent_accounting: Account<'info, IntentAccounting>,
    pub system_program: Program<'info, System>,
    // extra accounts
    // for each sell token:
    //     0. sell token mint
    // for each buy token:
    //     0. buy token mint
}
