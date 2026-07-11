import { config } from './config.js';

/**
 * Staff tiers. Kurucu is above everything; Admin inherits everything below it,
 * and so on down the ladder. Command definitions declare the minimum tier.
 */
export const Tier = {
  MEMBER: 0,
  REHBER: 20,
  MOD: 40,
  BMOD: 60,
  ADMIN: 80,
  KURUCU: 100,
};

const TIER_NAMES = {
  [Tier.MEMBER]: 'Üye',
  [Tier.REHBER]: 'Rehber',
  [Tier.MOD]: 'Mod',
  [Tier.BMOD]: 'Baş Mod',
  [Tier.ADMIN]: 'Admin',
  [Tier.KURUCU]: 'Kurucu',
};

export function tierName(tier) {
  return TIER_NAMES[tier] ?? String(tier);
}

/** Resolves a guild member's tier from their roles (guild owner counts as Kurucu). */
export function tierOf(member) {
  if (!member) return Tier.MEMBER;
  if (member.guild && member.id === member.guild.ownerId) return Tier.KURUCU;
  const roles = member.roles?.cache;
  if (!roles) return Tier.MEMBER;
  if (roles.has(config.roles.kurucu)) return Tier.KURUCU;
  if (roles.has(config.roles.admin)) return Tier.ADMIN;
  if (roles.has(config.roles.bmod)) return Tier.BMOD;
  if (roles.has(config.roles.mod)) return Tier.MOD;
  if (roles.has(config.roles.rehber)) return Tier.REHBER;
  return Tier.MEMBER;
}

export function hasTier(member, minTier) {
  return tierOf(member) >= minTier;
}

/** True when the actor outranks the target (needed before punishing someone). */
export function outranks(actor, target) {
  return tierOf(actor) > tierOf(target);
}
