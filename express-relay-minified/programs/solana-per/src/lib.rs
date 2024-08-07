pub mod state;

use anchor_lang::prelude::*;

use anchor_lang::solana_program::{serialize_utils::read_u16};
use anchor_lang::solana_program::sysvar::instructions::{load_instruction_at_checked,load_current_index_checked, ID as sysvar_instructions_id};
use anchor_spl::token::{Mint, Token, Transfer, TokenAccount, transfer, Approve, approve};
use crate::state::*;

declare_id!("3qiTuH24j5XUYtiEoidyCaJi8tb8LPD9oXecJrRR1m2K");

pub const FEE_SPLIT_PRECISION: u64 = 10_000;

#[program]
pub mod solana_per {
    use super::*;


    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let express_relay_config = &mut ctx.accounts.express_relay_config;
        express_relay_config.admin = *ctx.accounts.admin.key;
        Ok(())
    }

    pub fn initialize_relayer(ctx: Context<InitializeRelayer>, data: InitializeRelayerArgs) -> Result<()> {
        let express_relay_metadata_data = &mut ctx.accounts.express_relay_metadata;
        // ctx.accounts.express_relay_metadata.bump = ctx.bumps.express_relay_metadata;
        express_relay_metadata_data.relayer_signer = *ctx.accounts.relayer_signer.key;
        express_relay_metadata_data.relayer_fee_receiver = *ctx.accounts.relayer_fee_receiver.key;
        express_relay_metadata_data.split_protocol_default = data.split_protocol_default;
        express_relay_metadata_data.split_relayer = data.split_relayer;
        Ok(())
    }

    pub fn check_permission(ctx: Context<CheckPermission>, _data: CheckPermissionArgs) -> Result<()> {
        let num_instructions = read_u16(&mut 0, &ctx.accounts.sysvar_instructions.data.borrow()).map_err(|_| ProgramError::InvalidInstructionData)?;
        for index in 0..num_instructions {
            let ix = load_instruction_at_checked(index.into(), &ctx.accounts.sysvar_instructions)?;
            if ix.program_id == crate::id() {
                // check if the correct permission is allowed in this instruction
                return Ok(());
            }
        }
        return Ok(());
    }

    pub fn permission(ctx: Context<Permission>, data: PermissionArgs) -> Result<()> {
        // make sure not a cpi
        let instruction_index = load_current_index_checked(&ctx.accounts.sysvar_instructions.to_account_info())?;
        let instruction = load_instruction_at_checked(instruction_index.into(),&ctx.accounts.sysvar_instructions.to_account_info())?;
        if instruction.program_id == crate::id() {
            // not CPI
        } else {

            //TODO: throw error
        }


        // transfer from searcher
        {
            let cpi_accounts_transfer = Transfer {
                from: ctx.accounts.bid_token.to_account_info(),
                to: ctx.accounts.bid_protocol.to_account_info(),
                authority: ctx.accounts.express_relay_metadata.to_account_info(),
            };
            let cpi_program_transfer = ctx.accounts.token_program.to_account_info().clone();
            transfer(
                CpiContext::new_with_signer(
                    cpi_program_transfer,
                    cpi_accounts_transfer,
                    &[&[crate::SEED_METADATA, ctx.accounts.express_relay_metadata.relayer_fee_receiver.key().as_ref(), &[ctx.bumps.express_relay_metadata]]],
                ),
                data.bid_amount,
            )?;
        }

        // transfer to bid_receiver
        {
            let cpi_accounts_transfer = Transfer {
                from: ctx.accounts.bid_protocol.to_account_info(),
                to: ctx.accounts.bid_receiver.to_account_info(),
                authority: ctx.accounts.express_relay_metadata.to_account_info(),
            };
            let cpi_program_transfer = ctx.accounts.token_program.to_account_info().clone();
            let receiver_amount = data.bid_amount.checked_mul(ctx.accounts.express_relay_metadata.split_protocol_default)
                .ok_or(ErrorCode::InvalidNumericConversion)?
                .checked_div( FEE_SPLIT_PRECISION)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
            transfer(
                CpiContext::new_with_signer(
                    cpi_program_transfer,
                    cpi_accounts_transfer,
                    &[&[crate::SEED_METADATA, ctx.accounts.express_relay_metadata.relayer_fee_receiver.key().as_ref(), &[ctx.bumps.express_relay_metadata]]],
                ),
                receiver_amount,
            )?;
        }


        // approve to relayer_fee_receiver
        {
            let current_delegated_amount = ctx.accounts.bid_protocol.delegated_amount;
            let relayer_amount = data.bid_amount.checked_mul(ctx.accounts.express_relay_metadata.split_relayer)
                .ok_or(ErrorCode::InvalidNumericConversion)?
                .checked_div( FEE_SPLIT_PRECISION)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
            let new_delegated_amount = current_delegated_amount + relayer_amount;
            let cpi_accounts_approve = Approve {
                to: ctx.accounts.bid_protocol.to_account_info(),
                delegate: ctx.accounts.relayer_fee_receiver.to_account_info(),
                authority: ctx.accounts.express_relay_metadata.to_account_info(),
            };
            let cpi_program_approve = ctx.accounts.token_program.to_account_info().clone();
            approve(
                CpiContext::new_with_signer(
                    cpi_program_approve,
                    cpi_accounts_approve,
                    &[&[crate::SEED_METADATA, ctx.accounts.express_relay_metadata.relayer_fee_receiver.key().as_ref(), &[ctx.bumps.express_relay_metadata]]],
                ),
                new_delegated_amount,
            )?;
        }

        Ok(())
    }
}


#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct InitializeRelayerArgs {
    pub split_protocol_default: u64,
    pub split_relayer: u64,
}

pub const SEED_METADATA: &[u8] = b"metadata";


#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init, payer = payer, space = RESERVE_CONFIG, seeds = [SEED_CONFIG], bump
    )]
    pub express_relay_config: Account<'info, ExpressRelayConfig>,
    /// CHECK: this is just the PK for the admin to sign from
    pub admin: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeRelayer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [SEED_CONFIG], bump, has_one = admin
    )]
    pub express_relay_config: Account<'info, ExpressRelayConfig>,
    #[account(
        init, payer = admin, space = RESERVE_EXPRESS_RELAY_METADATA, seeds = [SEED_METADATA, relayer_fee_receiver.key().as_ref()], bump
    )]
    pub express_relay_metadata: Account<'info, ExpressRelayMetadata>,
    /// CHECK: this is just the PK for the relayer to sign from
    pub relayer_signer: UncheckedAccount<'info>,
    /// CHECK: this is just a PK for the relayer to receive fees at
    pub relayer_fee_receiver: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}


#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct PermissionArgs {
    pub permission_id: [u8; 32],
    pub bid_amount: u64,
}

#[derive(Accounts)]
pub struct Permission<'info> {
    #[account(mut)]
    pub relayer_signer: Signer<'info>,
    /// CHECK: this is just the protocol fee receiver PK
    #[account(mut,
    token::mint = bid_mint,
    )]
    pub bid_token: Account<'info, TokenAccount>,
    #[account(mut,
    token::mint = bid_mint,
    token::authority = express_relay_metadata,
    )]
    pub bid_protocol: Account<'info, TokenAccount>,
    #[account(mut,
    token::mint = bid_mint,
    )]
    pub bid_receiver: Account<'info, TokenAccount>,
    pub bid_mint: Account<'info, Mint>,
    #[account(
        mut, seeds = [SEED_METADATA, express_relay_metadata.relayer_fee_receiver.key().as_ref()], bump
    )]
    pub express_relay_metadata: Account<'info, ExpressRelayMetadata>,
    /// CHECK: this is just a PK for the relayer to receive fees at
    pub relayer_fee_receiver: UncheckedAccount<'info>,
    /// CHECK: program address
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    /// CHECK: this is the sysvar instructions account
    #[account(address = sysvar_instructions_id)]
    pub sysvar_instructions: UncheckedAccount<'info>,
}


#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone, Copy, Debug)]
pub struct CheckPermissionArgs {
    pub permission_id: [u8; 32]
}
#[derive(Accounts)]
pub struct CheckPermission<'info> {
    /// CHECK: this is the sysvar instructions account
    #[account(address = sysvar_instructions_id)]
    pub sysvar_instructions: UncheckedAccount<'info>,

}
