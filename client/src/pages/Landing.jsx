import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

const workflows = [
  {
    label: 'People',
    title: 'Start the day knowing who is working and what needs attention.',
    items: ['Browser-based clock-in for mobile teams', 'Schedules, time off, and team messages', 'Approvals before payroll closes'],
  },
  {
    label: 'Work',
    title: 'Capture the workday without chasing texts, photos, and memory.',
    items: ['Notes, photos, tasks, and service records', 'Checklists for repeatable work', 'Customer, project, and daily history'],
  },
  {
    label: 'Resources',
    title: 'Keep stock, tools, and documents attached to the right place.',
    items: ['Inventory by location, area, rack, bay, and bin', 'Counts, transfers, and purchase activity', 'Files attached to the work they belong to'],
  },
  {
    label: 'Back office',
    title: 'Turn daily activity into approvals, reports, and cleaner payroll.',
    items: ['Overtime and pay-period controls', 'Reports for managers and clients', 'QuickBooks Online sync add-on'],
  },
];

const differences = [
  {
    label: 'Simple for the team',
    title: 'The daily screen can stay small, even when the system is powerful.',
    items: ['Show only the tools each role needs', 'Keep specialist workflows tucked away', 'Use labels that match the company language'],
  },
  {
    label: 'More than time tracking',
    title: 'Time, work records, inventory, and approvals live together.',
    items: ['Fewer disconnected spreadsheets and side chats', 'Cleaner context for payroll and reporting', 'One place to find what happened'],
  },
  {
    label: 'Built for movement',
    title: 'It works for teams moving between desks, sites, shops, and customers.',
    items: ['Mobile browser access with no app-store rollout', 'Offline queue for spotty signal', 'Admin controls when the work gets complex'],
  },
];

const proof = [
  ['Approvals ready', '18'],
  ['People active', '7'],
  ['Open requests', '3'],
  ['Stock alerts', '6'],
];

const plans = [
  { name: 'Free', price: '$0', detail: 'Up to 3 team members, time clock, scheduling, and recent history.' },
  { name: 'Starter', price: '$20', detail: 'Up to 10 team members, geofencing, exports, mileage, and pay-period controls.' },
  { name: 'Business', price: '$35', detail: 'Reports, work tracking, customers, checklists, analytics, and 15 team members included.', featured: true },
];

function MiniDashboard() {
  return (
    <div className="landing-product-panel" aria-label="OpsFloa workflow preview">
      <div className="landing-panel-top">
        <div>
          <span className="landing-panel-eyebrow">Today in OpsFloa</span>
          <h2>Daily Command Center</h2>
        </div>
        <span className="landing-status-pill">Live</span>
      </div>
      <div className="landing-proof-grid">
        {proof.map(([label, value]) => (
          <div key={label} className="landing-proof-cell">
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="landing-timeline">
        <div className="landing-timeline-row">
          <span className="landing-dot green" />
          <div>
            <strong>Morning team check-in</strong>
            <p>People, locations, and exceptions are visible</p>
          </div>
        </div>
        <div className="landing-timeline-row">
          <span className="landing-dot amber" />
          <div>
            <strong>Customer request updated</strong>
            <p>Photos, notes, and status stay with the work</p>
          </div>
        </div>
        <div className="landing-timeline-row">
          <span className="landing-dot blue" />
          <div>
            <strong>Payroll prep is cleaner</strong>
            <p>Approved hours are ready for export or sync</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const [openFaq, setOpenFaq] = useState(null);

  useDocumentMeta({
    title: 'OpsFloa - Simple Operations Software for Time, Work, Inventory, and Payroll Prep',
    description: 'OpsFloa helps teams manage time, daily work, inventory, approvals, reports, and payroll prep from one customizable browser-based operations hub.',
  });

  return (
    <div className="landing-page" id="top">
      <header className="landing-header landing-shell">
        <a href="#top" className="landing-brand" aria-label="OpsFloa home">
          <img className="landing-brand-mark" src="/icon-96x96.png" alt="" />
          <span>
            <strong>OpsFloa</strong>
            <small>Operations Flow Assistant</small>
          </span>
        </a>
        <nav className="landing-nav" aria-label="Landing page navigation">
          <a href="#workflows">Workflows</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="landing-actions">
          <Link to="/login">Log in</Link>
          <Link to="/register" className="landing-btn landing-btn-small">Start free</Link>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <picture className="landing-hero-picture">
            <source media="(max-width: 720px)" srcSet="/opsfloa-mobile-hero.png" />
            <img className="landing-hero-img" src="/opsfloa-field-hero.png" alt="" />
          </picture>
          <div className="landing-hero-scrim" />
          <div className="landing-shell landing-hero-grid">
            <div className="landing-hero-copy">
              <p className="landing-kicker">The daily operations hub for teams in motion</p>
              <h1>OpsFloa</h1>
              <p className="landing-lede">
                A simple place to run time, work, inventory, approvals, and payroll prep. Keep the everyday screen clean for the team, while admins get the controls and records they need when the work gets complicated.
              </p>
              <div className="landing-hero-proof" aria-label="OpsFloa highlights">
                <span>No app-store rollout</span>
                <span>Offline queue</span>
                <span>Custom roles and labels</span>
              </div>
              <div className="landing-hero-buttons">
                <Link to="/register" className="landing-btn">Create free account</Link>
                <a href="#workflows" className="landing-ghost-btn">See what it covers</a>
              </div>
              <p className="landing-trust">No credit card to start. Built for crews, shops, service teams, offices, and field/mobile operations that need order without extra busywork.</p>
            </div>
            <MiniDashboard />
          </div>
        </section>

        <section className="landing-strip">
          <div className="landing-shell landing-strip-grid">
            <span>GPS time clock</span>
            <span>Daily work records</span>
            <span>Checklists</span>
            <span>Inventory</span>
            <span>Payroll approvals</span>
          </div>
        </section>

        <section id="workflows" className="landing-section landing-shell">
          <div className="landing-section-head">
            <p className="landing-kicker">One calm operating system</p>
            <h2>Everything the office needs from the workday, without making the team dig for it.</h2>
            <p>OpsFloa is designed around the daily loop: people start work, activity is captured, exceptions rise to the surface, and the back office closes the day with fewer loose ends.</p>
          </div>
          <div className="landing-workflow-grid">
            {workflows.map(workflow => (
              <article key={workflow.label} className="landing-workflow-card">
                <span>{workflow.label}</span>
                <h3>{workflow.title}</h3>
                <ul>
                  {workflow.items.map(item => <li key={item}>{item}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-operator-band">
          <div className="landing-shell landing-operator-grid">
            <div>
              <p className="landing-kicker">Mobile-first, office-ready</p>
              <h2>Built for the gap between doing the work and proving what happened.</h2>
            </div>
            <div className="landing-operator-copy">
              <p>Team members get a simple daily path. Admins get approvals, reports, inventory movement, customer history, and exceptions. The system keeps the record so no one has to reconstruct the week from messages, memory, and scattered files.</p>
              <Link to="/register" className="landing-inline-link">Create your free account</Link>
            </div>
          </div>
        </section>

        <section className="landing-section landing-shell">
          <div className="landing-section-head">
            <p className="landing-kicker">Why OpsFloa</p>
            <h2>Use one flexible system instead of forcing the team through five disconnected tools.</h2>
            <p>Most teams do not need more software noise. They need the important actions up front, the deeper controls nearby, and a reliable record of the day when payroll, customers, managers, or inventory questions come up.</p>
          </div>
          <div className="landing-difference-grid">
            {differences.map(difference => (
              <article key={difference.label} className="landing-workflow-card">
                <span>{difference.label}</span>
                <h3>{difference.title}</h3>
                <ul>
                  {difference.items.map(item => <li key={item}>{item}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section id="pricing" className="landing-pricing-band">
          <div className="landing-section landing-shell">
            <div className="landing-section-head">
              <p className="landing-kicker">Simple pricing</p>
              <h2>Start small. Add the operational depth only when the team needs it.</h2>
            </div>
            <div className="landing-pricing-grid">
              {plans.map(plan => (
                <article key={plan.name} className={`landing-plan ${plan.featured ? 'featured' : ''}`}>
                  {plan.featured && <span className="landing-plan-badge">Most useful</span>}
                  <h3>{plan.name}</h3>
                  <div className="landing-price">{plan.price}<small>/mo</small></div>
                  <p>{plan.detail}</p>
                  <Link to="/register" className={plan.featured ? 'landing-btn' : 'landing-ghost-btn dark'}>Start free</Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="landing-section landing-shell landing-faq-section">
          <div className="landing-section-head">
            <p className="landing-kicker">Questions</p>
            <h2>The basics, without the brochure fog.</h2>
          </div>
          <div className="landing-faq-list">
            {[
              ['Does the team need an app store download?', 'No. OpsFloa runs in the mobile browser and can be installed to the home screen as a PWA.'],
              ['Does it work in bad signal?', 'Yes. Clock and work submissions can queue locally and sync when the connection returns.'],
              ['Can different teams see different tools?', 'Yes. OpsFloa is built around roles, modules, and company labels so the app can stay simple day to day.'],
              ['Can it handle payroll details?', 'Yes. It supports approvals, overtime, prevailing wage workflows, pay-period locks, reports, and QuickBooks sync as an add-on.'],
            ].map(([q, a], index) => (
              <div key={q} className="landing-faq-item">
                <button type="button" onClick={() => setOpenFaq(openFaq === index ? null : index)}>
                  <span>{q}</span>
                  <span>{openFaq === index ? '-' : '+'}</span>
                </button>
                {openFaq === index && <p>{a}</p>}
              </div>
            ))}
          </div>
        </section>

        <section className="landing-final">
          <div className="landing-shell landing-final-content">
            <p className="landing-kicker">OpsFloa</p>
            <h2>Give the team a simple way to report work. Give the office a clean way to close the day.</h2>
            <Link to="/register" className="landing-btn">Start free</Link>
          </div>
        </section>
      </main>

      <footer className="landing-footer landing-shell">
        <span>OpsFloa</span>
        <div>
          <Link to="/privacy">Privacy</Link>
          <Link to="/eula">Terms</Link>
          <Link to="/login">Log in</Link>
        </div>
      </footer>
    </div>
  );
}
