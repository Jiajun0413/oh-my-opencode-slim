import type { ResolveMarketplaceActivationOptions } from './activation';
import { resolveMarketplaceActivation } from './activation';
import {
  createMarketplaceAgentDefinitions,
  type MarketplaceAgentDefinitions,
  type MarketplaceAgentMetadata,
} from './agent-definitions';

export interface MarketplaceRegistryImplementation {
  resolveMarketplaceActivation: typeof resolveMarketplaceActivation;
  createMarketplaceAgentDefinitions: typeof createMarketplaceAgentDefinitions;
}

export type {
  MarketplaceAgentDefinitions,
  MarketplaceAgentMetadata,
  ResolveMarketplaceActivationOptions,
};
export { createMarketplaceAgentDefinitions, resolveMarketplaceActivation };
