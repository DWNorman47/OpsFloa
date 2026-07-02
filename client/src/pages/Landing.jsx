import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';

const buildWorkflows = t => [
  {
    label: t.lpWorkflowPeopleLabel,
    title: t.lpWorkflowPeopleTitle,
    items: [t.lpWorkflowPeopleItem1, t.lpWorkflowPeopleItem2, t.lpWorkflowPeopleItem3],
  },
  {
    label: t.lpWorkflowWorkLabel,
    title: t.lpWorkflowWorkTitle,
    items: [t.lpWorkflowWorkItem1, t.lpWorkflowWorkItem2, t.lpWorkflowWorkItem3],
  },
  {
    label: t.lpWorkflowResourcesLabel,
    title: t.lpWorkflowResourcesTitle,
    items: [t.lpWorkflowResourcesItem1, t.lpWorkflowResourcesItem2, t.lpWorkflowResourcesItem3],
  },
  {
    label: t.lpWorkflowBackOfficeLabel,
    title: t.lpWorkflowBackOfficeTitle,
    items: [t.lpWorkflowBackOfficeItem1, t.lpWorkflowBackOfficeItem2, t.lpWorkflowBackOfficeItem3],
  },
];

const buildDifferences = t => [
  {
    label: t.lpDiffSimpleLabel,
    title: t.lpDiffSimpleTitle,
    items: [t.lpDiffSimpleItem1, t.lpDiffSimpleItem2, t.lpDiffSimpleItem3],
  },
  {
    label: t.lpDiffMoreLabel,
    title: t.lpDiffMoreTitle,
    items: [t.lpDiffMoreItem1, t.lpDiffMoreItem2, t.lpDiffMoreItem3],
  },
  {
    label: t.lpDiffMovementLabel,
    title: t.lpDiffMovementTitle,
    items: [t.lpDiffMovementItem1, t.lpDiffMovementItem2, t.lpDiffMovementItem3],
  },
];

const buildProof = t => [
  [t.lpProofApprovals, '18'],
  [t.lpProofPeople, '7'],
  [t.lpProofRequests, '3'],
  [t.lpProofStock, '6'],
];

const buildPlans = t => [
  { name: t.lpPlanFreeName, price: '$0', detail: t.lpPlanFreeDetail },
  { name: t.lpPlanStarterName, price: '$20', detail: t.lpPlanStarterDetail },
  { name: t.lpPlanBusinessName, price: '$35', detail: t.lpPlanBusinessDetail, featured: true },
];

function MiniDashboard({ t }) {
  const proof = buildProof(t);
  return (
    <div className="landing-product-panel" aria-label="OpsFloa workflow preview">
      <div className="landing-panel-top">
        <div>
          <span className="landing-panel-eyebrow">{t.lpPanelEyebrow}</span>
          <h2>{t.lpPanelTitle}</h2>
        </div>
        <span className="landing-status-pill">{t.lpPanelLive}</span>
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
            <strong>{t.lpTimeline1Title}</strong>
            <p>{t.lpTimeline1Text}</p>
          </div>
        </div>
        <div className="landing-timeline-row">
          <span className="landing-dot amber" />
          <div>
            <strong>{t.lpTimeline2Title}</strong>
            <p>{t.lpTimeline2Text}</p>
          </div>
        </div>
        <div className="landing-timeline-row">
          <span className="landing-dot blue" />
          <div>
            <strong>{t.lpTimeline3Title}</strong>
            <p>{t.lpTimeline3Text}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const [openFaq, setOpenFaq] = useState(null);
  const t = getT(detectLanguage());
  const workflows = buildWorkflows(t);
  const differences = buildDifferences(t);
  const plans = buildPlans(t);
  const faqs = [
    [t.lpFaq1Q, t.lpFaq1A],
    [t.lpFaq2Q, t.lpFaq2A],
    [t.lpFaq3Q, t.lpFaq3A],
    [t.lpFaq4Q, t.lpFaq4A],
  ];

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
            <small>{t.lpBrandTagline}</small>
          </span>
        </a>
        <nav className="landing-nav" aria-label="Landing page navigation">
          <a href="#workflows">{t.lpNavWorkflows}</a>
          <a href="#pricing">{t.lpNavPricing}</a>
          <a href="#faq">{t.lpNavFaq}</a>
        </nav>
        <div className="landing-actions">
          <Link to="/login">{t.lpLogIn}</Link>
          <Link to="/register" className="landing-btn landing-btn-small">{t.lpStartFree}</Link>
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
              <p className="landing-kicker">{t.lpHeroKicker}</p>
              <h1>OpsFloa</h1>
              <p className="landing-lede">
                {t.lpHeroLede}
              </p>
              <div className="landing-hero-proof" aria-label="OpsFloa highlights">
                <span>{t.lpHeroProof1}</span>
                <span>{t.lpHeroProof2}</span>
                <span>{t.lpHeroProof3}</span>
              </div>
              <div className="landing-hero-buttons">
                <Link to="/register" className="landing-btn">{t.lpHeroCtaPrimary}</Link>
                <a href="#workflows" className="landing-ghost-btn">{t.lpHeroCtaSecondary}</a>
              </div>
              <p className="landing-trust">{t.lpHeroTrust}</p>
            </div>
            <MiniDashboard t={t} />
          </div>
        </section>

        <section className="landing-strip">
          <div className="landing-shell landing-strip-grid">
            <span>{t.lpStrip1}</span>
            <span>{t.lpStrip2}</span>
            <span>{t.lpStrip3}</span>
            <span>{t.lpStrip4}</span>
            <span>{t.lpStrip5}</span>
          </div>
        </section>

        <section id="workflows" className="landing-section landing-shell">
          <div className="landing-section-head">
            <p className="landing-kicker">{t.lpWorkflowsKicker}</p>
            <h2>{t.lpWorkflowsHeading}</h2>
            <p>{t.lpWorkflowsIntro}</p>
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
              <p className="landing-kicker">{t.lpOperatorKicker}</p>
              <h2>{t.lpOperatorHeading}</h2>
            </div>
            <div className="landing-operator-copy">
              <p>{t.lpOperatorCopy}</p>
              <Link to="/register" className="landing-inline-link">{t.lpOperatorLink}</Link>
            </div>
          </div>
        </section>

        <section className="landing-section landing-shell">
          <div className="landing-section-head">
            <p className="landing-kicker">{t.lpWhyKicker}</p>
            <h2>{t.lpWhyHeading}</h2>
            <p>{t.lpWhyIntro}</p>
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
              <p className="landing-kicker">{t.lpPricingKicker}</p>
              <h2>{t.lpPricingHeading}</h2>
            </div>
            <div className="landing-pricing-grid">
              {plans.map(plan => (
                <article key={plan.name} className={`landing-plan ${plan.featured ? 'featured' : ''}`}>
                  {plan.featured && <span className="landing-plan-badge">{t.lpPlanBadge}</span>}
                  <h3>{plan.name}</h3>
                  <div className="landing-price">{plan.price}<small>{t.lpPerMonth}</small></div>
                  <p>{plan.detail}</p>
                  <Link to="/register" className={plan.featured ? 'landing-btn' : 'landing-ghost-btn dark'}>{t.lpStartFree}</Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="landing-section landing-shell landing-faq-section">
          <div className="landing-section-head">
            <p className="landing-kicker">{t.lpFaqKicker}</p>
            <h2>{t.lpFaqHeading}</h2>
          </div>
          <div className="landing-faq-list">
            {faqs.map(([q, a], index) => (
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
            <h2>{t.lpFinalHeading}</h2>
            <Link to="/register" className="landing-btn">{t.lpStartFree}</Link>
          </div>
        </section>
      </main>

      <footer className="landing-footer landing-shell">
        <span>OpsFloa</span>
        <div>
          <Link to="/privacy">{t.lpFooterPrivacy}</Link>
          <Link to="/eula">{t.lpFooterTerms}</Link>
          <Link to="/login">{t.lpLogIn}</Link>
        </div>
      </footer>
    </div>
  );
}
