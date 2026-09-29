'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldAlert,
  Send,
  Sparkles,
  Check,
  Copy,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
  FileText,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Database,
  ArrowRight,
  Terminal,
  Activity,
  Layers,
  Download
} from 'lucide-react';
import {
  Incident,
  SearchResult,
  MitigationAction,
  RedHerringAction
} from '@/lib/types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  timestamp: string;
  searchResult?: SearchResult | null;
  feedback?: Record<string, { status: 'worked' | 'failed'; reason?: string }>;
}

const SAMPLE_PROMPTS = [
  {
    title: 'Payments Connection Pool',
    query: 'payments-service: Postgres connection timeout spike (active pg_connections 100/100, p99 > 8500ms, HTTP 504 on /api/v2/charge)'
  },
  {
    title: 'Catalog Cache Storm',
    query: 'catalog-search: Upstream DB query timeouts, HTTP 503 error rate > 48% on /search/items with Redis memory at 99.9%'
  },
  {
    title: 'Checkout CPU 99% Scan',
    query: 'checkout-api: Postgres CPU 99.8% (Saturation), query latency > 14000ms on SELECT * FROM orders WHERE status = PENDING'
  },
  {
    title: 'Auth 401 JWKS Desync',
    query: 'auth-gateway: 401 Unauthorized spike (68% failure rate), JWT kid not found in cached JWKS'
  },
  {
    title: 'Billing Kafka Poison Pill',
    query: 'billing-worker: Consumer group lag > 320,000 msgs on topic payments.settled, worker CPU 100% on partition 4'
  }
];

export default function ChatbotIncidentAgent() {
  const [isMounted, setIsMounted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activePostmortem, setActivePostmortem] = useState<{ id: string; markdown: string } | null>(null);
  const [allIncidents, setAllIncidents] = useState<Incident[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [failingAction, setFailingAction] = useState<{ messageId: string; actionId: string; actionTitle: string } | null>(null);
  const [failureReason, setFailureReason] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setIsMounted(true);
    fetchIncidents();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, failingAction]);

  const fetchIncidents = async () => {
    try {
      const res = await fetch('/api/incidents');
      const data = await res.json();
      setAllIncidents(data.incidents || []);
    } catch (e) {
      console.error('Failed to load incidents', e);
    }
  };

  const handleClearDatabase = async () => {
    if (!window.confirm('Are you sure you want to completely wipe all incidents from database memory?')) return;
    try {
      await fetch('/api/incidents', { method: 'DELETE' });
      setAllIncidents([]);
      setMessages([]);
      setShowArchive(false);
    } catch (e) {
      console.error('Failed to clear memory', e);
    }
  };

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend || input).trim();
    if (!query || isLoading) return;

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMessage]);
    if (!textToSend) setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: query,
          history: messages.map(m => ({
            role: m.role,
            content: m.content || m.searchResult?.primaryIncident?.title || ''
          }))
        })
      });
      const data = await res.json();

      let assistantMessage: ChatMessage;

      if (data.type === 'greeting') {
        assistantMessage = {
          id: `asst_${Date.now()}`,
          role: 'assistant',
          content: data.text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
      } else if (data.type === 'no_match' || data.type === 'learned') {
        if (data.type === 'learned') {
          fetchIncidents();
        }
        assistantMessage = {
          id: `asst_${Date.now()}`,
          role: 'assistant',
          content: data.text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
      } else {
        assistantMessage = {
          id: `asst_${Date.now()}`,
          role: 'assistant',
          searchResult: data.searchResult,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
      }

      setMessages(prev => [...prev, assistantMessage]);
    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: "Sorry, I ran into an error querying the incident memory engine. Please try again.",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyCommand = (cmd: string, id: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const recordFeedbackWorked = async (messageId: string, incidentId: string, actionId: string, actionTitle: string) => {
    // Update local state
    setMessages(prev =>
      prev.map(msg => {
        if (msg.id !== messageId) return msg;
        return {
          ...msg,
          feedback: {
            ...(msg.feedback || {}),
            [actionId]: { status: 'worked' }
          }
        };
      })
    );

    // Call backend
    try {
      await fetch('/api/mitigations/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId,
          actionId,
          outcome: 'worked',
          notes: 'Verified effective by user via chatbot.',
          actionTitle,
          durationMinutes: 3.0
        })
      });
      fetchIncidents();
    } catch (e) {
      console.error('Feedback recording failed', e);
    }

    // Add confirmation assistant message
    setMessages(prev => [
      ...prev,
      {
        id: `ack_${Date.now()}`,
        role: 'assistant',
        content: `✅ Recorded! Success score for **"${actionTitle}"** has been reinforced in memory. Future incidents will prioritize this solution.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]);
  };

  const submitFailure = async () => {
    if (!failingAction) return;
    const { messageId, actionId, actionTitle } = failingAction;
    const reasonText = failureReason.trim() || 'Failed during triage attempt.';

    // Update local message feedback state
    setMessages(prev =>
      prev.map(msg => {
        if (msg.id !== messageId) return msg;
        return {
          ...msg,
          feedback: {
            ...(msg.feedback || {}),
            [actionId]: { status: 'failed', reason: reasonText }
          }
        };
      })
    );

    // Find the message to get incident ID
    const targetMsg = messages.find(m => m.id === messageId);
    const incidentId = targetMsg?.searchResult?.primaryIncident?.id || 'INC-402';

    try {
      await fetch('/api/mitigations/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId,
          actionId,
          outcome: 'failed',
          notes: reasonText,
          actionTitle,
          durationMinutes: 12.0
        })
      });
      fetchIncidents();
    } catch (e) {
      console.error('Failure recording failed', e);
    }

    setFailingAction(null);
    setFailureReason('');

    // Add confirmation assistant message
    setMessages(prev => [
      ...prev,
      {
        id: `ack_fail_${Date.now()}`,
        role: 'assistant',
        content: `❌ Logged failure: **"${actionTitle}"** has been recorded in the anti-patterns archive (${reasonText}). The agent will warn future on-call engineers against attempting this.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]);
  };

  const openPostmortem = async (incidentId: string) => {
    try {
      const res = await fetch(`/api/postmortem/${incidentId}`);
      const data = await res.json();
      setActivePostmortem({ id: incidentId, markdown: data.markdown });
    } catch (e) {
      console.error('Failed to load postmortem', e);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#090d16] text-slate-100 font-sans">
      {/* Chatbot Header */}
      <header className="h-14 border-b border-slate-800/80 bg-[#090d16]/95 backdrop-blur px-5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm tracking-tight text-white">Incident Response Agent</span>
              <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Memory Active
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowArchive(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition-colors"
          >
            <Database className="w-3.5 h-3.5 text-indigo-400" />
            <span suppressHydrationWarning>{isMounted ? allIncidents.length : 0} Postmortems</span>
          </button>

          {messages.length > 0 && (
            <button
              onClick={() => {
                setMessages([]);
                setFailingAction(null);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Clear chat"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </header>

      {/* Chat Messages Stream */}
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-4xl w-full mx-auto flex flex-col gap-6">
        {/* Welcome Empty State */}
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center my-auto py-10">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 mb-4 shadow-lg shadow-indigo-500/10">
              <Sparkles className="w-6 h-6" />
            </div>

            <h1 className="text-xl font-bold text-white mb-2">How can I assist with your incident?</h1>
            <p className="text-xs text-slate-400 max-w-md mb-8 leading-relaxed">
              Paste an alert signature, describe an outage, or ask how to resolve an issue. I check historical postmortems to recommend verified fixes, flag dangerous pitfalls, and update memory with your feedback.
            </p>

            <div className="w-full flex flex-col gap-2 max-w-lg text-left">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-1">
                Try a simulated incident alert:
              </span>
              <div className="flex flex-col gap-2">
                {SAMPLE_PROMPTS.map((sample, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(sample.query)}
                    className="group bg-slate-900/60 hover:bg-slate-800/80 border border-slate-800/80 hover:border-slate-700 p-3 rounded-xl text-left transition-all flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <span className="font-semibold text-white group-hover:text-indigo-300 transition-colors block">
                        {sample.title}
                      </span>
                      <span className="text-[11px] text-slate-400 line-clamp-1">
                        {sample.query}
                      </span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-white shrink-0 group-hover:translate-x-0.5 transition-transform" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Message Thread */}
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            {/* User Message Bubble */}
            {msg.role === 'user' && (
              <div className="max-w-[85%] bg-indigo-600 text-white px-4 py-3 rounded-2xl rounded-tr-sm text-xs leading-relaxed shadow-sm">
                <p className="whitespace-pre-wrap">{msg.content}</p>
                <span className="text-[10px] text-indigo-200 mt-1 block text-right font-mono">
                  {msg.timestamp}
                </span>
              </div>
            )}

            {/* Assistant Simple Text Message */}
            {msg.role === 'assistant' && msg.content && (
              <div className="max-w-[88%] bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl rounded-tl-sm text-xs leading-relaxed text-slate-200 shadow-sm">
                <p className="whitespace-pre-wrap">{msg.content}</p>
                <span className="text-[10px] text-slate-500 mt-1 block font-mono">
                  {msg.timestamp}
                </span>
              </div>
            )}

            {/* Assistant Rich Incident Analysis Card */}
            {msg.role === 'assistant' && msg.searchResult && (
              <div className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4 shadow-xl">
                {/* Precedent Match Header */}
                {msg.searchResult.primaryIncident ? (
                  <div className="flex flex-col gap-2 pb-3 border-b border-slate-800">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          {msg.searchResult.primaryIncident.id}
                        </span>
                        <span className="text-xs font-mono text-slate-400">
                          {msg.searchResult.primaryIncident.service}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold text-emerald-400">
                          {msg.searchResult.primaryConfidence}% Match
                        </span>
                        <button
                          onClick={() => openPostmortem(msg.searchResult!.primaryIncident!.id)}
                          className="text-[11px] font-medium text-sky-400 hover:text-sky-300 underline flex items-center gap-1"
                        >
                          <FileText className="w-3 h-3" />
                          <span>Postmortem</span>
                        </button>
                      </div>
                    </div>

                    <h2 className="text-sm font-bold text-white">
                      {msg.searchResult.primaryIncident.title}
                    </h2>

                    <div className="bg-slate-950/60 border-l-2 border-indigo-400 p-2.5 rounded-r text-xs text-slate-300 leading-relaxed">
                      <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider block mb-0.5">
                        Historical Root Cause
                      </span>
                      {msg.searchResult.primaryIncident.rootCause}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">
                    No historical precedent matched.
                  </div>
                )}

                {/* Divergence Warning */}
                {msg.searchResult.divergenceAlert?.hasDivergenceRisk && (
                  <div className="bg-amber-950/20 border border-amber-500/40 rounded-xl p-3.5 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <div className="flex flex-col gap-1 text-xs">
                      <span className="font-bold text-amber-400">
                        Telemetry Divergence: {msg.searchResult.divergenceAlert.type}
                      </span>
                      <p className="text-slate-300 leading-relaxed">
                        {msg.searchResult.divergenceAlert.warningText}
                      </p>
                    </div>
                  </div>
                )}

                {/* Verified Mitigations with Feedback Buttons */}
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-emerald-400">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Verified Fixes (Empirically Ranked)</span>
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono font-normal">
                      Click feedback to update agent memory
                    </span>
                  </div>

                  {msg.searchResult.rankedRecommendations.verifiedFixes.map((fix, idx) => {
                    const isCopied = copiedId === fix.id;
                    const feedbackState = msg.feedback?.[fix.id];
                    const isFailingThis = failingAction?.messageId === msg.id && failingAction?.actionId === fix.id;
                    const successPct = Math.round((fix.empiricalScore || fix.successScore || 0.9) * 100);

                    return (
                      <div
                        key={fix.id}
                        className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-white">#{idx + 1} {fix.action}</span>
                          <span className="font-mono text-[11px] text-emerald-400">
                            {successPct}% success ({fix.avgResolutionMinutes}m MTTR)
                          </span>
                        </div>

                        {/* Command Code Box */}
                        <div className="bg-slate-900 border border-slate-800 rounded p-2 text-xs font-mono text-sky-300 flex items-center justify-between gap-2">
                          <code className="truncate">{fix.command}</code>
                          <button
                            onClick={() => copyCommand(fix.command, fix.id)}
                            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
                            title="Copy command"
                          >
                            {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>

                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          {fix.notes}
                        </p>

                        {/* Interactive Feedback Controls */}
                        <div className="pt-2 border-t border-slate-900 flex items-center justify-between text-xs">
                          <span className="text-[10px] text-slate-400">Did this mitigation work?</span>

                          {feedbackState?.status === 'worked' ? (
                            <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1">
                              <Check className="w-3 h-3" /> Worked (Reinforced in memory)
                            </span>
                          ) : feedbackState?.status === 'failed' ? (
                            <span className="text-[11px] font-semibold text-rose-400 flex items-center gap-1">
                              <XCircle className="w-3 h-3" /> Marked as failed ({feedbackState.reason || 'Archived'})
                            </span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => recordFeedbackWorked(msg.id, msg.searchResult!.primaryIncident?.id || 'INC-402', fix.id, fix.action)}
                                className="px-2.5 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-medium text-[11px] border border-emerald-500/30 flex items-center gap-1 transition-colors"
                              >
                                <ThumbsUp className="w-3 h-3" />
                                <span>Worked</span>
                              </button>

                              <button
                                onClick={() => setFailingAction({ messageId: msg.id, actionId: fix.id, actionTitle: fix.action })}
                                className="px-2.5 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-medium text-[11px] border border-rose-500/30 flex items-center gap-1 transition-colors"
                              >
                                <ThumbsDown className="w-3 h-3" />
                                <span>Didn&apos;t work</span>
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Inline Failure Reason Input Form */}
                        {isFailingThis && (
                          <div className="mt-2 p-2.5 rounded bg-rose-950/20 border border-rose-500/30 flex flex-col gap-2">
                            <span className="text-[10px] text-rose-300 font-semibold">
                              What happened? (e.g. timeout persisted, memory did not release):
                            </span>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={failureReason}
                                onChange={e => setFailureReason(e.target.value)}
                                placeholder="Describe why this failed..."
                                className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-rose-500"
                              />
                              <button
                                onClick={submitFailure}
                                className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium text-xs transition-colors shrink-0"
                              >
                                Record Failure
                              </button>
                              <button
                                onClick={() => setFailingAction(null)}
                                className="px-2 py-1 text-slate-400 hover:text-white text-xs"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Tracked Anti-Patterns / Pitfalls */}
                {msg.searchResult.rankedRecommendations.redHerrings.length > 0 && (
                  <div className="flex flex-col gap-2 pt-2 border-t border-slate-800">
                    <span className="text-xs font-semibold text-rose-400 flex items-center gap-1.5">
                      <XCircle className="w-4 h-4" />
                      <span>Dangerous Pitfalls (Proven to fail in past incidents)</span>
                    </span>

                    {msg.searchResult.rankedRecommendations.redHerrings.map(rh => (
                      <div
                        key={rh.id}
                        className="bg-rose-950/15 border border-rose-500/30 rounded-xl p-3 flex flex-col gap-1 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-rose-200">🚫 Avoid: {rh.action}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-400 font-bold">
                            {rh.dangerLevel} RISK
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 bg-slate-950 p-1.5 rounded truncate">
                          {rh.command}
                        </div>
                        <p className="text-[11px] text-rose-300/90 leading-relaxed mt-0.5">
                          <strong>Past consequence:</strong> {rh.failureOutcome}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl rounded-tl-sm w-fit animate-pulse">
            <Sparkles className="w-4 h-4 text-indigo-400 animate-spin" />
            <span>Scanning incident memory and ranking historical mitigations...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Floating Input Area */}
      <div className="border-t border-slate-800/80 bg-[#090d16] p-4 shrink-0">
        <div className="max-w-4xl mx-auto flex flex-col gap-2">
          <div className="relative flex items-center bg-slate-900 border border-slate-800 rounded-2xl focus-within:border-indigo-500 transition-colors shadow-lg">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Paste a production alert, describe an outage, or ask for incident recommendations..."
              suppressHydrationWarning
              className="w-full bg-transparent px-4 py-3 text-xs text-white placeholder-slate-500 focus:outline-none resize-none max-h-32"
            />
            <button
              onClick={() => handleSend()}
              disabled={isMounted ? (!input.trim() || isLoading) : undefined}
              suppressHydrationWarning
              className={`mr-2 p-2 rounded-xl transition-all ${
                isMounted && input.trim() && !isLoading
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20'
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
              }`}
              title="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-500 px-2 font-mono">
            <span>Press Enter to send, Shift+Enter for new line</span>
            <span suppressHydrationWarning>Grounded in {isMounted ? allIncidents.length : 0} historical postmortems</span>
          </div>
        </div>
      </div>

      {/* Postmortem Modal */}
      {activePostmortem && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-slate-800">
              <span className="text-sm font-bold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" />
                <span>Historical Postmortem: {activePostmortem.id}</span>
              </span>
              <button
                onClick={() => setActivePostmortem(null)}
                className="text-slate-400 hover:text-white p-1 rounded text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 font-mono text-xs text-slate-300 leading-relaxed bg-slate-950 whitespace-pre-wrap">
              {activePostmortem.markdown}
            </div>

            <div className="flex items-center justify-end gap-2 p-3 border-t border-slate-800">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(activePostmortem.markdown);
                  setCopiedId('pm_copy');
                  setTimeout(() => setCopiedId(null), 1800);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5"
              >
                {copiedId === 'pm_copy' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'pm_copy' ? 'Copied' : 'Copy Markdown'}</span>
              </button>
              <button
                onClick={() => {
                  const blob = new Blob([activePostmortem.markdown], { type: 'text/markdown' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `postmortem-${activePostmortem.id}.md`;
                  a.click();
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .md</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Incident Memory Archive Modal */}
      {showArchive && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-slate-800">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Database className="w-4 h-4 text-indigo-400" />
                  <span>Incident Memory Archive</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Indexed postmortems and learned mitigation scores currently powering the chatbot.
                </p>
              </div>
              <button
                onClick={() => setShowArchive(false)}
                className="text-slate-400 hover:text-white p-1 rounded text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 flex flex-col gap-3">
              {allIncidents.map(inc => (
                <div
                  key={inc.id}
                  className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        {inc.id}
                      </span>
                      <span className="text-xs font-mono text-slate-400">{inc.service}</span>
                      <span className="text-xs font-bold text-white">{inc.title}</span>
                    </div>

                    <button
                      onClick={() => openPostmortem(inc.id)}
                      className="text-xs text-sky-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      <FileText className="w-3 h-3" />
                      <span>View</span>
                    </button>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed">{inc.rootCause}</p>

                  <div className="flex items-center gap-3 text-[11px] text-slate-500 pt-1 border-t border-slate-900">
                    <span className="text-emerald-400 font-medium">{inc.successfulMitigations?.length || 0} verified fixes</span>
                    <span>•</span>
                    <span className="text-rose-400 font-medium">{inc.failedMitigations?.length || 0} tracked anti-patterns</span>
                    <span>•</span>
                    <span>MTTR: {inc.durationMinutes}m</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-slate-800 flex items-center justify-between">
              <button
                onClick={handleClearDatabase}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 transition-colors flex items-center gap-1.5"
                title="Wipe all incidents and feedback from database"
              >
                <span>Clear All Memory</span>
              </button>
              <button
                onClick={() => setShowArchive(false)}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
