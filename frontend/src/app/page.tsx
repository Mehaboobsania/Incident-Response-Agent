'use client';

import React, { useState, useEffect } from 'react';
import {
  ShieldAlert,
  Database,
  FileText,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Copy,
  Check,
  Download,
  Search,
  PlusCircle,
  ArrowRight,
  GitCompare,
  Activity,
  Layers,
  Sparkles
} from 'lucide-react';
import {
  Incident,
  SearchResult,
  ComparisonResult,
  MitigationAction,
  RedHerringAction
} from '@/lib/types';

interface DemoScenario {
  id: string;
  title: string;
  service: string;
  severity: 'P1' | 'P2';
  alertSignature: string;
  telemetry: {
    dbConnections: string;
    dbCpu: string;
    redisMemory: string;
    appCpu: string;
    queueDepth: string;
  };
  badgeLabel: string;
}

const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'alert_payments_pool',
    title: 'Postgres Connection Pool Exhaustion on Payments Service',
    service: 'payments-service',
    severity: 'P1',
    alertSignature: 'payments-service: Postgres connection timeout spike (active pg_connections 100/100, p99 > 8500ms, HTTP 504 on /api/v2/charge)',
    telemetry: {
      dbConnections: '100/100 (Saturated)',
      dbCpu: '14% (Idle waiting)',
      redisMemory: '42% (Normal)',
      appCpu: '22% (Normal)',
      queueDepth: '3,400 messages'
    },
    badgeLabel: 'Payments DB Pool'
  },
  {
    id: 'alert_deceptive_cache_storm',
    title: 'Database Query Timeouts on Product Catalog Search',
    service: 'catalog-search',
    severity: 'P1',
    alertSignature: 'catalog-search: Upstream DB query timeouts, HTTP 503 error rate > 48% on /search/items',
    telemetry: {
      dbConnections: '95/100 (High)',
      dbCpu: '88% (High saturation)',
      redisMemory: '99.9% (Exhausted)',
      appCpu: '72% (High)',
      queueDepth: '18,200 search RPCs'
    },
    badgeLabel: 'Catalog Cache Storm'
  },
  {
    id: 'alert_checkout_table_scan',
    title: 'Unindexed Table Scan During Flash Sale on Checkout API',
    service: 'checkout-api',
    severity: 'P1',
    alertSignature: 'checkout-api: Postgres CPU 99.8% (Saturation), query latency > 14000ms on SELECT * FROM orders WHERE status = "PENDING"',
    telemetry: {
      dbConnections: '68/100 (Safe)',
      dbCpu: '99.8% (Critical)',
      redisMemory: '38% (Normal)',
      appCpu: '44% (Normal)',
      queueDepth: '1,120 orders'
    },
    badgeLabel: 'Checkout Table Scan'
  },
  {
    id: 'alert_auth_jwks_desync',
    title: 'JWKS Key Rotation Desynchronization on Auth Gateway',
    service: 'auth-gateway',
    severity: 'P1',
    alertSignature: 'auth-gateway: 401 Unauthorized spike (68% failure rate), JWT kid not found in cached JWKS',
    telemetry: {
      dbConnections: '12/100 (Normal)',
      dbCpu: '8% (Normal)',
      redisMemory: '25% (Normal)',
      appCpu: '18% (Normal)',
      queueDepth: '0 messages'
    },
    badgeLabel: 'Auth JWKS Desync'
  },
  {
    id: 'alert_kafka_poison_pill',
    title: 'Kafka Consumer Poison Pill & Partition Starvation on Billing Worker',
    service: 'billing-worker',
    severity: 'P2',
    alertSignature: 'billing-worker: Consumer group lag > 320,000 msgs on topic payments.settled, worker CPU 100% on partition 4',
    telemetry: {
      dbConnections: '24/100 (Normal)',
      dbCpu: '16% (Normal)',
      redisMemory: '30% (Normal)',
      appCpu: '98% (Partition 4)',
      queueDepth: '320,000 lag'
    },
    badgeLabel: 'Billing Poison Pill'
  }
];

export default function IncidentResponseApp() {
  const [activeTab, setActiveTab] = useState<'triage' | 'comparison' | 'memory' | 'ingest'>('triage');
  const [selectedScenario, setSelectedScenario] = useState<DemoScenario>(DEMO_SCENARIOS[0]);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [comparisonResult, setComparisonResult] = useState<ComparisonResult | null>(null);
  const [allIncidents, setAllIncidents] = useState<Incident[]>([]);
  const [memorySearchQuery, setMemorySearchQuery] = useState('');
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [activePostmortem, setActivePostmortem] = useState<{ id: string; markdown: string } | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'danger' | 'info' | 'warning' } | null>(null);
  const [isResolved, setIsResolved] = useState(false);
  const [loading, setLoading] = useState(false);

  // Failure feedback dialog state (clean inline modal, no browser prompt)
  const [feedbackModal, setFeedbackModal] = useState<{
    isOpen: boolean;
    incidentId: string;
    actionId: string;
    actionTitle: string;
    reason: string;
  } | null>(null);

  // Ingest form state
  const [ingestForm, setIngestForm] = useState({
    title: '',
    service: '',
    rootCause: '',
    fixTitle: '',
    fixCmd: '',
    failTitle: '',
    failDesc: ''
  });

  useEffect(() => {
    fetchIncidents();
    triggerAlertTriage(DEMO_SCENARIOS[0]);
  }, []);

  const showToast = (text: string, type: 'success' | 'danger' | 'info' | 'warning' = 'info') => {
    setToastMessage({ text, type });
    setTimeout(() => {
      setToastMessage(null);
    }, 3200);
  };

  const fetchIncidents = async () => {
    try {
      const res = await fetch('/api/incidents');
      const data = await res.json();
      setAllIncidents(data.incidents || []);
    } catch (e) {
      console.error('Failed to fetch incidents', e);
    }
  };

  const triggerAlertTriage = async (scenario: DemoScenario) => {
    setSelectedScenario(scenario);
    setIsResolved(false);
    setLoading(true);

    try {
      const [searchRes, compRes] = await Promise.all([
        fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert: scenario })
        }),
        fetch('/api/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert: scenario })
        })
      ]);

      const searchData: SearchResult = await searchRes.json();
      const compData: ComparisonResult = await compRes.json();

      setSearchResult(searchData);
      setComparisonResult(compData);
    } catch (err) {
      console.error('Triage error', err);
      showToast('Error analyzing incident', 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleActionWorked = async (incidentId: string, actionId: string, actionTitle: string) => {
    showToast(`Recorded success for "${actionTitle}". Score reinforced.`, 'success');
    setIsResolved(true);

    try {
      const res = await fetch('/api/mitigations/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId,
          actionId,
          outcome: 'worked',
          notes: 'Verified effective during triage.',
          actionTitle,
          durationMinutes: 3.0
        })
      });
      const data = await res.json();
      if (data.success) {
        fetchIncidents();
        const refreshed = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert: selectedScenario })
        });
        const refData = await refreshed.json();
        setSearchResult(refData);
      }
    } catch (e) {
      console.error('Feedback recording failed', e);
    }
  };

  const submitFailureFeedback = async () => {
    if (!feedbackModal) return;
    const { incidentId, actionId, actionTitle, reason } = feedbackModal;
    setFeedbackModal(null);

    showToast(`Marked "${actionTitle}" as failed. Archived to prevent repetition.`, 'danger');

    try {
      const res = await fetch('/api/mitigations/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId,
          actionId,
          outcome: 'failed',
          notes: reason || 'Failed during triage attempt.',
          actionTitle,
          durationMinutes: 15.0
        })
      });
      const data = await res.json();
      if (data.success) {
        fetchIncidents();
        const refreshed = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert: selectedScenario })
        });
        const refData = await refreshed.json();
        setSearchResult(refData);
      }
    } catch (e) {
      console.error('Feedback recording failed', e);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const openPostmortem = async (incidentId: string) => {
    try {
      const res = await fetch(`/api/postmortem/${incidentId}`);
      const data = await res.json();
      setActivePostmortem({ id: incidentId, markdown: data.markdown });
    } catch (e) {
      showToast('Failed to load postmortem', 'danger');
    }
  };

  const downloadPostmortem = () => {
    if (!activePostmortem) return;
    const blob = new Blob([activePostmortem.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `postmortem-${activePostmortem.id}.md`;
    a.click();
    showToast('Postmortem report downloaded', 'info');
  };

  const handleIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const newInc: Partial<Incident> = {
      title: ingestForm.title,
      service: ingestForm.service,
      severity: 'P1',
      environment: 'production',
      rootCause: ingestForm.rootCause,
      durationMinutes: 15,
      resolver: 'oncall.engineer',
      successfulMitigations: ingestForm.fixTitle ? [{
        id: `act_${Date.now()}`,
        action: ingestForm.fixTitle,
        command: ingestForm.fixCmd || '# custom mitigation command',
        timesWorked: 1,
        timesAttempted: 1,
        avgResolutionMinutes: 4.0,
        successScore: 0.8,
        notes: 'Ingested from postmortem documentation.'
      }] : [],
      failedMitigations: ingestForm.failTitle ? [{
        id: `fail_${Date.now()}`,
        action: ingestForm.failTitle,
        command: '# failed command',
        timesFailed: 1,
        timesAttempted: 1,
        failureRate: 1.0,
        dangerLevel: 'HIGH',
        failureOutcome: ingestForm.failDesc || 'Failed during incident resolution.'
      }] : []
    };

    try {
      const res = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newInc)
      });
      const data = await res.json();
      showToast(`Incident ${data.incident.id} saved to memory.`, 'success');
      setIngestForm({
        title: '',
        service: '',
        rootCause: '',
        fixTitle: '',
        fixCmd: '',
        failTitle: '',
        failDesc: ''
      });
      await fetchIncidents();
      setActiveTab('memory');
    } catch (err) {
      showToast('Failed to ingest incident', 'danger');
    }
  };

  const filteredIncidents = allIncidents.filter(inc => {
    if (!memorySearchQuery) return true;
    const q = memorySearchQuery.toLowerCase();
    return inc.title.toLowerCase().includes(q) ||
           inc.service.toLowerCase().includes(q) ||
           inc.id.toLowerCase().includes(q) ||
           inc.rootCause.toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col min-h-screen bg-[#090d16] text-slate-100">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-lg shadow-xl bg-slate-900 border border-slate-700 text-xs font-medium text-slate-200 animate-in fade-in slide-in-from-bottom-2 duration-150">
          {toastMessage.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
          {toastMessage.type === 'danger' && <XCircle className="w-4 h-4 text-rose-400" />}
          {toastMessage.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400" />}
          {toastMessage.type === 'info' && <Activity className="w-4 h-4 text-sky-400" />}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Main Top Header */}
      <header className="sticky top-0 z-40 bg-[#090d16]/90 backdrop-blur-md border-b border-slate-800/80 px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm tracking-tight text-white">Incident Response Agent</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700/60">
                  {allIncidents.length} indexed
                </span>
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl">
            <button
              onClick={() => setActiveTab('triage')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'triage'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Live Triage</span>
            </button>

            <button
              onClick={() => setActiveTab('comparison')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'comparison'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <GitCompare className="w-3.5 h-3.5" />
              <span>Memory vs Baseline</span>
            </button>

            <button
              onClick={() => setActiveTab('memory')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'memory'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              <span>Incident History</span>
            </button>

            <button
              onClick={() => setActiveTab('ingest')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'ingest'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Ingest Postmortem</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl w-full mx-auto px-6 py-5 flex-1">
        {/* =========================================================================
             VIEW 1: LIVE TRIAGE
             ========================================================================= */}
        {activeTab === 'triage' && (
          <div className="flex flex-col gap-5">
            {/* Top Control Bar: Incident Switcher & Status Actions */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 overflow-x-auto text-xs py-0.5">
                <span className="text-slate-400 font-medium whitespace-nowrap text-[11px] mr-1">Active Incident:</span>
                {DEMO_SCENARIOS.map(sc => {
                  const isSelected = selectedScenario.id === sc.id;
                  return (
                    <button
                      key={sc.id}
                      onClick={() => triggerAlertTriage(sc)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 ${
                        isSelected
                          ? 'bg-slate-800 text-white border-slate-600 shadow-sm'
                          : 'bg-slate-950/40 text-slate-400 border-slate-800/80 hover:text-slate-200 hover:border-slate-700'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${sc.severity === 'P1' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                      <span>{sc.service}</span>
                    </button>
                  );
                })}
              </div>

              {/* Status and Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setIsResolved(!isResolved);
                    showToast(isResolved ? 'Incident reopened' : 'Incident marked as resolved', isResolved ? 'info' : 'success');
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors ${
                    isResolved
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{isResolved ? 'Resolved' : 'Mark Resolved'}</span>
                </button>

                {searchResult?.primaryIncident && (
                  <button
                    onClick={() => openPostmortem(searchResult.primaryIncident!.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5 text-sky-400" />
                    <span>Postmortem</span>
                  </button>
                )}
              </div>
            </div>

            {/* 2-Column Clean Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Left Column: Context, Telemetry & Historical Match (7 cols) */}
              <div className="lg:col-span-7 flex flex-col gap-4">
                {/* Active Alert Card */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                        {selectedScenario.service}
                      </span>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                        selectedScenario.severity === 'P1'
                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      }`}>
                        {selectedScenario.severity} Severity
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400 font-mono">Triggered via Production Alert</span>
                  </div>

                  <h1 className="text-lg font-bold text-white leading-snug">
                    {selectedScenario.title}
                  </h1>

                  <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3 font-mono text-xs text-slate-300 break-all">
                    {selectedScenario.alertSignature}
                  </div>

                  {/* Telemetry Metric Cards */}
                  <div>
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
                      Live Telemetry
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {Object.entries(selectedScenario.telemetry).map(([key, val]) => {
                        const isWarning = val.includes('High') || val.includes('Exhausted') || val.includes('Critical') || val.includes('Saturated');
                        return (
                          <div
                            key={key}
                            className={`p-2.5 rounded-lg border text-xs ${
                              isWarning
                                ? 'bg-rose-950/20 border-rose-500/30 text-rose-200'
                                : 'bg-slate-950/50 border-slate-800/80 text-slate-300'
                            }`}
                          >
                            <span className="text-[10px] text-slate-400 block capitalize mb-0.5">
                              {key.replace(/([A-Z])/g, ' $1')}
                            </span>
                            <span className="font-mono font-medium">{val}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Divergence Warning Alert (if detected) */}
                {searchResult?.divergenceAlert?.hasDivergenceRisk && (
                  <div className="bg-amber-950/20 border border-amber-500/40 rounded-xl p-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-amber-400">
                          Telemetry Divergence Warning: {searchResult.divergenceAlert.type}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {searchResult.divergenceAlert.warningText}
                      </p>
                      {searchResult.divergenceAlert.flags && (
                        <div className="flex flex-col gap-1 mt-1">
                          {searchResult.divergenceAlert.flags.map((flag, idx) => (
                            <div key={idx} className="text-[11px] font-mono text-slate-300 bg-slate-950/60 px-2.5 py-1.5 rounded border border-slate-800">
                              <span className="text-slate-400">{flag.metric}:</span> Expected {flag.expected} vs Current <span className="text-rose-400 font-bold">{flag.current}</span> — {flag.detail}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Historical Memory Context */}
                {searchResult?.primaryIncident ? (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                          Precedent: {searchResult.primaryIncident.id}
                        </span>
                        <span className="text-xs text-slate-400">
                          Resolved in {searchResult.primaryIncident.durationMinutes}m by {searchResult.primaryIncident.resolver}
                        </span>
                      </div>
                      <span className="text-xs font-mono font-medium text-emerald-400">
                        {searchResult.primaryConfidence}% Match
                      </span>
                    </div>

                    <h2 className="text-sm font-semibold text-white">
                      {searchResult.primaryIncident.title}
                    </h2>

                    <div className="bg-slate-950/60 border-l-2 border-indigo-400 rounded-r-lg p-3 text-xs text-slate-300 leading-relaxed">
                      <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider block mb-1">
                        Historical Root Cause
                      </span>
                      {searchResult.primaryIncident.rootCause}
                    </div>
                  </div>
                ) : (
                  <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400">
                    No historical match found in memory.
                  </div>
                )}
              </div>

              {/* Right Column: Actions & Mitigations (5 cols) */}
              <div className="lg:col-span-5 flex flex-col gap-4">
                {/* Verified Mitigations (What Worked) */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Verified Solutions</span>
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      Ranked by historical success
                    </span>
                  </div>

                  <div className="flex flex-col gap-2.5">
                    {searchResult?.rankedRecommendations?.verifiedFixes?.map((fix, idx) => {
                      const successPct = Math.round((fix.empiricalScore || fix.successScore || 0.9) * 100);
                      const isCopied = copiedCodeId === fix.id;
                      return (
                        <div key={fix.id} className="bg-slate-950/80 border border-slate-800 rounded-lg p-3.5 flex flex-col gap-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-white">{fix.action}</span>
                            <span className="font-mono text-[11px] text-emerald-400 font-medium">
                              {successPct}% success ({fix.avgResolutionMinutes}m MTTR)
                            </span>
                          </div>

                          <div className="bg-slate-900 border border-slate-800 rounded p-2 text-xs font-mono text-sky-300 flex items-center justify-between gap-2">
                            <code className="truncate">{fix.command}</code>
                            <button
                              onClick={() => copyToClipboard(fix.command, fix.id)}
                              className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition-colors shrink-0"
                              title="Copy command"
                            >
                              {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>

                          <p className="text-[11px] text-slate-400 leading-normal">
                            {fix.notes}
                          </p>

                          <div className="flex items-center justify-between pt-2 border-t border-slate-900 text-xs">
                            <span className="text-[10px] text-slate-400">Record outcome:</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleActionWorked(fix.sourceIncidentId || searchResult.primaryIncident!.id, fix.id, fix.action)}
                                className="px-2.5 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-medium text-[11px] border border-emerald-500/30 transition-colors"
                              >
                                Worked
                              </button>
                              <button
                                onClick={() => setFeedbackModal({
                                  isOpen: true,
                                  incidentId: fix.sourceIncidentId || searchResult.primaryIncident!.id,
                                  actionId: fix.id,
                                  actionTitle: fix.action,
                                  reason: ''
                                })}
                                className="px-2.5 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-medium text-[11px] border border-rose-500/30 transition-colors"
                              >
                                Failed
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Actions to Avoid (Known Pitfalls) */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <span className="text-xs font-semibold text-rose-400 flex items-center gap-1.5">
                      <XCircle className="w-4 h-4" />
                      <span>Actions to Avoid (Known Pitfalls)</span>
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      Failed in past incidents
                    </span>
                  </div>

                  <div className="flex flex-col gap-2.5">
                    {searchResult?.rankedRecommendations?.redHerrings?.map((rh) => (
                      <div key={rh.id} className="bg-slate-950/80 border border-rose-500/20 rounded-lg p-3 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-rose-200">{rh.action}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">
                            {rh.dangerLevel} RISK
                          </span>
                        </div>

                        <div className="bg-slate-900 border border-slate-800 rounded p-1.5 text-xs font-mono text-slate-400 truncate">
                          {rh.command}
                        </div>

                        <p className="text-[11px] text-slate-400 leading-normal bg-rose-950/20 border-l-2 border-rose-500/60 p-2 rounded-r">
                          <strong className="text-rose-300">Why this fails:</strong> {rh.failureOutcome}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================================
             VIEW 2: MEMORY VS BASELINE COMPARISON
             ========================================================================= */}
        {activeTab === 'comparison' && comparisonResult && (
          <div className="flex flex-col gap-5">
            {/* Impact Metric Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                <span className="text-[11px] text-slate-400 font-medium block mb-1">MTTR With Memory</span>
                <span className="text-2xl font-bold font-mono text-emerald-400">
                  {comparisonResult.metricsComparison.mttrIraMinutes}m
                </span>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                <span className="text-[11px] text-slate-400 font-medium block mb-1">MTTR Without Memory</span>
                <span className="text-2xl font-bold font-mono text-rose-400">
                  {comparisonResult.metricsComparison.mttrZeroMinutes}m
                </span>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                <span className="text-[11px] text-slate-400 font-medium block mb-1">MTTR Reduction</span>
                <span className="text-2xl font-bold font-mono text-sky-400">
                  -{comparisonResult.metricsComparison.mttrReductionPercent}%
                </span>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                <span className="text-[11px] text-slate-400 font-medium block mb-1">Downtime Saved</span>
                <span className="text-2xl font-bold font-mono text-indigo-400">
                  {comparisonResult.metricsComparison.estimatedOutageSavedMinutes}m
                </span>
              </div>
            </div>

            {/* Split Screen Comparison */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Left: Generic AI Without Memory */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div>
                    <h2 className="text-sm font-bold text-white">Generic AI (Zero Memory)</h2>
                    <p className="text-xs text-slate-400">Standard generalist LLM without system knowledge</p>
                  </div>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    ~{comparisonResult.zeroMemoryAgent.estimatedMttrMinutes}m MTTR
                  </span>
                </div>

                <div className="text-xs text-slate-400 bg-slate-950/60 p-2.5 rounded border border-slate-800">
                  Relies on generic runbook guesses; unaware of previous outage outcomes or cascading failure risks.
                </div>

                <div className="flex flex-col gap-2.5">
                  {comparisonResult.zeroMemoryAgent.mitigationPlan.map(step => (
                    <div
                      key={step.order}
                      className={`p-3 rounded-lg border text-xs ${
                        step.isDangerous
                          ? 'bg-rose-950/20 border-rose-500/30 text-slate-200'
                          : 'bg-slate-950/50 border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-white">#{step.order} {step.step}</span>
                        {step.isDangerous && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                            Dangerous Action
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-sky-400 bg-slate-900 p-1.5 rounded my-1 truncate">
                        {step.command}
                      </div>
                      <p className="text-[11px] text-slate-400">{step.rationale}</p>
                      {step.risk && (
                        <p className="text-[11px] text-rose-400 font-medium mt-1">
                          Risk: {step.risk}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: Incident Response Agent with Hindsight Memory */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div>
                    <h2 className="text-sm font-bold text-white">Incident Response Agent (With Memory)</h2>
                    <p className="text-xs text-emerald-400 font-medium">Grounded in indexed postmortems & failure logs</p>
                  </div>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                    ~{comparisonResult.metricsComparison.mttrIraMinutes}m MTTR
                  </span>
                </div>

                <div className="text-xs text-slate-300 bg-emerald-950/20 p-2.5 rounded border border-emerald-500/30">
                  Surfaces verified, system-specific fixes immediately and explicitly flags past failed actions.
                </div>

                <div className="flex flex-col gap-2.5">
                  {comparisonResult.iraAgent.rankedRecommendations.verifiedFixes.slice(0, 1).map(fix => (
                    <div key={fix.id} className="p-3.5 rounded-lg border border-emerald-500/30 bg-emerald-950/10 text-xs flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Recommended Fix</span>
                        </span>
                        <span className="text-[11px] font-mono text-emerald-400">{fix.avgResolutionMinutes}m MTTR</span>
                      </div>
                      <h3 className="font-medium text-white">{fix.action}</h3>
                      <div className="font-mono text-[11px] text-emerald-300 bg-slate-950 p-2 rounded border border-emerald-500/20 truncate">
                        {fix.command}
                      </div>
                      <p className="text-[11px] text-slate-400">{fix.notes}</p>
                    </div>
                  ))}

                  {comparisonResult.iraAgent.rankedRecommendations.redHerrings.slice(0, 1).map(rh => (
                    <div key={rh.id} className="p-3.5 rounded-lg border border-rose-500/30 bg-rose-950/10 text-xs flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-rose-400 flex items-center gap-1.5">
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Blocked Action</span>
                        </span>
                        <span className="text-[10px] font-mono text-rose-400 font-medium">Failed {rh.timesFailed}x previously</span>
                      </div>
                      <h3 className="font-medium text-rose-200">{rh.action}</h3>
                      <div className="font-mono text-[11px] text-rose-300 bg-slate-950 p-2 rounded border border-rose-500/20 truncate">
                        {rh.command}
                      </div>
                      <p className="text-[11px] text-rose-200 bg-rose-950/30 p-2 rounded border-l-2 border-rose-500/60">
                        {rh.failureOutcome}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================================
             VIEW 3: INCIDENT HISTORY / MEMORY EXPLORER
             ========================================================================= */}
        {activeTab === 'memory' && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white">Incident Archive & Memory</h2>
                <p className="text-xs text-slate-400">Indexed production postmortems, verified mitigations, and past failures.</p>
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Filter by service, root cause, ID..."
                  value={memorySearchQuery}
                  onChange={(e) => setMemorySearchQuery(e.target.value)}
                  className="bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-64"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredIncidents.map(inc => (
                <div key={inc.id} className="bg-slate-900/60 border border-slate-800 hover:border-slate-700 rounded-xl p-4 flex flex-col justify-between transition-colors">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                        {inc.id}
                      </span>
                      <span className="text-xs font-mono text-slate-400">{inc.service}</span>
                    </div>

                    <h3 className="text-xs font-bold text-white leading-snug">{inc.title}</h3>
                    <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed">{inc.rootCause}</p>
                  </div>

                  <div className="pt-3 mt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span>{inc.successfulMitigations?.length || 0} fixes</span>
                      <span>•</span>
                      <span>{inc.durationMinutes}m MTTR</span>
                    </div>

                    <button
                      onClick={() => openPostmortem(inc.id)}
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1 transition-colors"
                    >
                      <FileText className="w-3 h-3 text-sky-400" />
                      <span>Postmortem</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* =========================================================================
             VIEW 4: INGEST NEW INCIDENT / POSTMORTEM
             ========================================================================= */}
        {activeTab === 'ingest' && (
          <div className="max-w-2xl mx-auto bg-slate-900/60 border border-slate-800 rounded-xl p-6">
            <h2 className="text-base font-bold text-white mb-1">Ingest Incident Postmortem</h2>
            <p className="text-xs text-slate-400 mb-5">
              Record verified solutions and failed attempts into the agent's long-term memory.
            </p>

            <form onSubmit={handleIngestSubmit} className="flex flex-col gap-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Incident Title</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Memory Leak on Recommendation Worker"
                    value={ingestForm.title}
                    onChange={(e) => setIngestForm({ ...ingestForm, title: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-slate-600"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Service Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. recommendation-worker"
                    value={ingestForm.service}
                    onChange={(e) => setIngestForm({ ...ingestForm, service: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-slate-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Root Cause</label>
                <textarea
                  required
                  rows={3}
                  placeholder="Technical breakdown of the root cause..."
                  value={ingestForm.rootCause}
                  onChange={(e) => setIngestForm({ ...ingestForm, rootCause: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-slate-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-lg flex flex-col gap-2">
                  <label className="font-semibold text-emerald-400">Verified Solution (What Worked)</label>
                  <input
                    type="text"
                    placeholder="Action title"
                    value={ingestForm.fixTitle}
                    onChange={(e) => setIngestForm({ ...ingestForm, fixTitle: e.target.value })}
                    className="bg-slate-900 border border-slate-800 rounded p-2 text-white"
                  />
                  <input
                    type="text"
                    placeholder="Shell / CLI command"
                    value={ingestForm.fixCmd}
                    onChange={(e) => setIngestForm({ ...ingestForm, fixCmd: e.target.value })}
                    className="bg-slate-900 border border-slate-800 rounded p-2 font-mono text-[11px] text-emerald-300"
                  />
                </div>

                <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-lg flex flex-col gap-2">
                  <label className="font-semibold text-rose-400">Pitfall to Avoid (What Failed)</label>
                  <input
                    type="text"
                    placeholder="Action title (e.g. Pod restart)"
                    value={ingestForm.failTitle}
                    onChange={(e) => setIngestForm({ ...ingestForm, failTitle: e.target.value })}
                    className="bg-slate-900 border border-slate-800 rounded p-2 text-white"
                  />
                  <input
                    type="text"
                    placeholder="Why did this action fail?"
                    value={ingestForm.failDesc}
                    onChange={(e) => setIngestForm({ ...ingestForm, failDesc: e.target.value })}
                    className="bg-slate-900 border border-slate-800 rounded p-2 text-rose-300"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="mt-2 py-2.5 rounded-lg font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              >
                Save to Incident Memory
              </button>
            </form>
          </div>
        )}
      </main>

      {/* Postmortem Markdown Modal */}
      {activePostmortem && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-slate-800">
              <span className="text-sm font-semibold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" />
                <span>Postmortem: {activePostmortem.id}</span>
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
                onClick={() => copyToClipboard(activePostmortem.markdown, 'postmortem')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 flex items-center gap-1.5"
              >
                {copiedCodeId === 'postmortem' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCodeId === 'postmortem' ? 'Copied' : 'Copy'}</span>
              </button>

              <button
                onClick={downloadPostmortem}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Failure Feedback Modal (Replaces browser prompt) */}
      {feedbackModal?.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-5 flex flex-col gap-4 shadow-2xl">
            <div>
              <h3 className="text-sm font-bold text-white mb-1">Record Failed Action</h3>
              <p className="text-xs text-slate-400">
                Why did &ldquo;{feedbackModal.actionTitle}&rdquo; fail? This will be saved to memory to protect future on-call engineers.
              </p>
            </div>

            <textarea
              rows={3}
              placeholder="e.g. Triggered database connection saturation or query timeouts..."
              value={feedbackModal.reason}
              onChange={(e) => setFeedbackModal({ ...feedbackModal, reason: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-slate-600"
            />

            <div className="flex items-center justify-end gap-2 text-xs">
              <button
                onClick={() => setFeedbackModal(null)}
                className="px-3 py-1.5 rounded-lg font-medium text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={submitFailureFeedback}
                className="px-3 py-1.5 rounded-lg font-semibold bg-rose-600 hover:bg-rose-500 text-white"
              >
                Save Failure
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
