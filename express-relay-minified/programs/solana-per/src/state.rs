use anchor_lang::prelude::*;

pub const RESERVE_EXPRESS_RELAY_METADATA: usize = 8+112;
pub const SEED_METADATA: &[u8] = b"metadata";


pub const RESERVE_CONFIG: usize = 100;
pub const SEED_CONFIG: &[u8] = b"config";


#[account]
#[derive(Default)]
pub struct ExpressRelayConfig {
    pub admin: Pubkey,
    pub new_admin: Pubkey,
}


#[account]
#[derive(Default)]
pub struct ExpressRelayMetadata {
    pub relayer_signer: Pubkey,
    pub relayer_fee_receiver: Pubkey,
    pub split_protocol_default: u64,
    pub split_relayer: u64,
}
