import * as vscode from 'vscode';

export interface ChatOptimizationConfig {
  enableInstructionCaching: boolean;
  enableProgressiveTools: boolean;
  enableSmartHistory: boolean;
  enableConversationTracking: boolean;
  enableHybridApproach: boolean;
  
  // Phase 1: Caching
  cacheTtlMs: number;
  
  // Phase 2: Tools
  maxToolsRound0: number;
  maxToolsTotal: number;
  
  // Phase 3: History
  maxHistoryTurns: number;
  historyCharsPerTurn: number;
  historyRelevanceFiltering: boolean;
  
  // Phase 4: State
  stateCleanupIntervalMs: number;
}

export const DEFAULT_CHAT_OPTIMIZATION_CONFIG: ChatOptimizationConfig = {
  enableInstructionCaching: true,
  enableProgressiveTools: true,
  enableSmartHistory: true,
  enableConversationTracking: true,
  enableHybridApproach: true,
  
  cacheTtlMs: 10 * 60 * 1000, // 10 minutes
  
  maxToolsRound0: 2,
  maxToolsTotal: 6,
  
  maxHistoryTurns: 4,
  historyCharsPerTurn: 800,
  historyRelevanceFiltering: true,
  
  stateCleanupIntervalMs: 30 * 60 * 1000, // 30 minutes
};

export class ChatOptimizationManager {
  private config: ChatOptimizationConfig;

  constructor() {
    this.config = { ...DEFAULT_CHAT_OPTIMIZATION_CONFIG };
  }

  getConfig(): ChatOptimizationConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<ChatOptimizationConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  resetConfig(): void {
    this.config = { ...DEFAULT_CHAT_OPTIMIZATION_CONFIG };
  }
}

export const chatOptimizationManager = new ChatOptimizationManager();
