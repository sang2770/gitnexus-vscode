import * as vscode from 'vscode';
import { getOutputChannel } from '../process/cli-runner.js';

export interface ChatMetrics {
  tokensSaved: number;
  tokensUsed: number;
  responseTimeMs: number;
  cacheHits: number;
  cacheMisses: number;
  toolCallsCount: number;
  roundCount: number;
  timestamp: number;
  workflow: string;
}

export class ChatMetricsCollector {
  private metrics: ChatMetrics[] = [];

  recordMetric(metric: Omit<ChatMetrics, 'timestamp'>): void {
    this.metrics.push({
      ...metric,
      timestamp: Date.now(),
    });
    
    // Log every 10 metrics or when specifically requested
    if (this.metrics.length % 5 === 0) {
      this.logSummary();
    }
  }

  getAggregatedMetrics() {
    if (this.metrics.length === 0) return null;

    const total = this.metrics.reduce((acc, m) => ({
      tokensSaved: acc.tokensSaved + m.tokensSaved,
      tokensUsed: acc.tokensUsed + m.tokensUsed,
      cacheHits: acc.cacheHits + m.cacheHits,
      toolCallsCount: acc.toolCallsCount + m.toolCallsCount,
    }), { tokensSaved: 0, tokensUsed: 0, cacheHits: 0, toolCallsCount: 0 });

    return {
      count: this.metrics.length,
      averageTokensSaved: total.tokensSaved / this.metrics.length,
      totalTokensSaved: total.tokensSaved,
      cacheHitRate: total.cacheHits / (total.cacheHits + (this.metrics.length - total.cacheHits)),
      averageToolCalls: total.toolCallsCount / this.metrics.length,
    };
  }

  getMetricsByWorkflow(workflow: string): ChatMetrics[] {
    return this.metrics.filter(m => m.workflow === workflow);
  }

  logSummary(): void {
    const summary = this.getAggregatedMetrics();
    if (!summary) return;

    const channel = getOutputChannel();
    channel.appendLine('--- CodeBrain Chat Optimization Metrics ---');
    channel.appendLine(`Sessions tracked: ${summary.count}`);
    channel.appendLine(`Total tokens saved: ${summary.totalTokensSaved.toLocaleString()}`);
    channel.appendLine(`Average tokens saved/msg: ${summary.averageTokensSaved.toFixed(0)}`);
    channel.appendLine(`Cache hit rate: ${(summary.cacheHitRate * 100).toFixed(1)}%`);
    channel.appendLine(`Average tool calls: ${summary.averageToolCalls.toFixed(1)}`);
    channel.appendLine('------------------------------------------');
  }

  clear(): void {
    this.metrics = [];
  }
}

export const chatMetricsCollector = new ChatMetricsCollector();
