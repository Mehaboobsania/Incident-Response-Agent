# Incident Response Agent (IRA)

An AI-powered incident response assistant for on-call reliability engineers (SREs). Grounded in organizational memory (**Hindsight Engine**), IRA recalls past production incidents, ranks verified mitigations by empirical success rate, and flags dangerous anti-patterns before they cause cascading outages.

---

## Quickstart Guide

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher

---

### 1. Run the Web Application

From the root project directory:

```bash
# 1. Navigate to frontend directory
cd frontend

# 2. Install dependencies (first-time only)
npm install

# 3. Start the Next.js development server
npm run dev
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

### 2. Run in Production Mode

To create an optimized production build and serve it:

```bash
cd frontend
npm run build
npm start
```

---

### 3. Run the Backend Test Suite

To test the Hindsight memory engine, mitigation ranking, and divergence detection logic:

```bash
# Run from the project root
node tests/hindsight.test.js
```

---

## Key Features

- **Live Triage Console**: Ingest production alerts, inspect telemetry metrics (connections, CPU, memory, queue depth), and view matched historical postmortems.
- **Verified Mitigations & Anti-Patterns**: Surfaces commands that resolved previous incidents and explicitly warns against steps that caused outages (e.g. cold restart thundering herds).
- **Telemetry Divergence Detection**: Detects "deceptive twin" incidents where surface symptoms match a past issue but telemetry indicates a different root cause.
- **Memory vs Baseline Comparison**: Side-by-side evaluation contrasting a zero-memory generic AI with the Hindsight-augmented agent (demonstrating ~93% MTTR reduction).
- **Incident Archive & Ingestion**: Browse historical postmortems or ingest new incident outcomes into long-term memory.
