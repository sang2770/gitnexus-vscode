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
      responseTimeMs: acc.responseTimeMs + m.responseTimeMs,
      cacheHits: acc.cacheHits + m.cacheHits,
      cacheMisses: acc.cacheMisses + m.cacheMisses,
      toolCallsCount: acc.toolCallsCount + m.toolCallsCount,
    }), { tokensSaved: 0, tokensUsed: 0, responseTimeMs: 0, cacheHits: 0, cacheMisses: 0, toolCallsCount: 0 });

    const cacheLookups = total.cacheHits + total.cacheMisses;

    return {
      count: this.metrics.length,
      averageTokensSaved: total.tokensSaved / this.metrics.length,
      averageTokensUsed: total.tokensUsed / this.metrics.length,
      totalTokensSaved: total.tokensSaved,
      averageResponseTimeMs: total.responseTimeMs / this.metrics.length,
      cacheHitRate: cacheLookups > 0 ? total.cacheHits / cacheLookups : 0,
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
    channel.appendLine(`Average input tokens/msg: ${summary.averageTokensUsed.toFixed(0)}`);
    channel.appendLine(`Average response time: ${summary.averageResponseTimeMs.toFixed(0)} ms`);
    channel.appendLine(`Cache hit rate: ${(summary.cacheHitRate * 100).toFixed(1)}%`);
    channel.appendLine(`Average tool calls: ${summary.averageToolCalls.toFixed(1)}`);
    channel.appendLine('------------------------------------------');
  }

  clear(): void {
    this.metrics = [];
  }
}

export const chatMetricsCollector = new ChatMetricsCollector();
