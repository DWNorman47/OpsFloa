import React from 'react';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';
import { formatDate } from '../utils';

function ListSection({ title, items }) {
  if (!items?.length) return null;
  return (
    <section className="pcp-section">
      <h2>{title}</h2>
      <div className="pcp-pill-list">
        {items.map(item => <span key={item}>{item}</span>)}
      </div>
    </section>
  );
}

function TextSection({ title, children }) {
  if (!children) return null;
  return (
    <section className="pcp-section">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

function ContactBlock({ contact, t }) {
  const hasContact = contact?.name || contact?.phone || contact?.email || contact?.website || contact?.address;
  if (!hasContact) return null;
  return (
    <section className="pcp-contact" aria-label={t.pcpContactInfoAria}>
      {contact.name && <div><strong>{t.pcpContact}</strong><span>{contact.name}</span></div>}
      {contact.phone && <div><strong>{t.pcpPhone}</strong><a href={`tel:${contact.phone}`}>{contact.phone}</a></div>}
      {contact.email && <div><strong>{t.pcpEmail}</strong><a href={`mailto:${contact.email}`}>{contact.email}</a></div>}
      {contact.website && <div><strong>{t.pcpWebsite}</strong><a href={contact.website} target="_blank" rel="noopener noreferrer">{contact.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a></div>}
      {contact.address && <div><strong>{t.pcpAddress}</strong><span>{contact.address}</span></div>}
    </section>
  );
}

export default function PublicCompanyProfileView({ profile, preview = false, language, t: tProp }) {
  const lang = language || detectLanguage(profile?.client_language || profile?.language);
  const t = tProp || getT(lang);
  const contact = profile?.contact_info || {};
  const photos = profile?.photos || [];
  const requestHref = profile?.accepts_service_requests && profile?.slug ? `/r/${profile.slug}` : null;
  const updated = profile?.updated_at ? formatDate(profile.updated_at, lang) : '';
  const name = profile?.display_name || profile?.company_name || t.pcpCompanyProfile;

  return (
    <article className={`public-company-profile ${preview ? 'pcp-preview' : ''}`}>
      <style>{css}</style>
      <header className="pcp-hero">
        <div>
          <p className="pcp-kicker">{preview ? t.pcpPreview : t.pcpCompanyProfile}</p>
          <h1>{name}</h1>
          {profile?.short_description && <p className="pcp-description">{profile.short_description}</p>}
          {updated && <p className="pcp-updated">{t.pcpLastUpdated} {updated}</p>}
        </div>
        <div className="pcp-actions">
          {requestHref && <a className="pcp-primary" href={requestHref}>{t.pcpRequestWork}</a>}
          {contact.email && <a className="pcp-secondary" href={`mailto:${contact.email}`}>{t.pcpEmail}</a>}
          {contact.phone && <a className="pcp-secondary" href={`tel:${contact.phone}`}>{t.pcpCall}</a>}
        </div>
      </header>

      {photos.length > 0 && (
        <section className="pcp-photo-grid" aria-label={t.pcpPhotosAria}>
          {photos.map((photo, index) => (
            <figure key={`${photo.url}-${index}`}>
              <img src={photo.url} alt={photo.alt || photo.caption || `${name} ${t.pcpExample} ${index + 1}`} loading="lazy" />
              {photo.caption && <figcaption>{photo.caption}</figcaption>}
            </figure>
          ))}
        </section>
      )}

      <div className="pcp-layout">
        <main className="pcp-main">
          <ListSection title={t.pcpServicesOffered} items={profile?.services_offered} />
          <ListSection title={t.pcpProjectTypes} items={profile?.project_types} />
          <ListSection title={t.pcpEquipmentCapabilities} items={profile?.equipment_capabilities} />
          <TextSection title={t.pcpLicensesCertifications}>{profile?.license_info}</TextSection>
          <TextSection title={t.pcpRequestingQuote}>{profile?.quote_instructions}</TextSection>

          {profile?.faq_items?.length > 0 && (
            <section className="pcp-section">
              <h2>{t.pcpFaqTitle}</h2>
              <div className="pcp-faq-list">
                {profile.faq_items.map((item, index) => (
                  <details key={`${item.question}-${index}`}>
                    <summary>{item.question}</summary>
                    <p>{item.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          )}
        </main>

        <aside className="pcp-side">
          <ListSection title={t.pcpServiceAreas} items={profile?.service_areas} />
          <ContactBlock contact={contact} t={t} />
          {requestHref && (
            <section className="pcp-request-box">
              <h2>{t.pcpNeedWorkTitle}</h2>
              <p>{t.pcpNeedWorkBody}</p>
              <a href={requestHref}>{t.pcpOpenRequestForm}</a>
            </section>
          )}
        </aside>
      </div>
    </article>
  );
}

const css = `
.public-company-profile {
  max-width: 1080px;
  margin: 0 auto;
  color: #0f172a;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.pcp-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: start;
  padding: 42px 0 28px;
  border-bottom: 1px solid #dbe4ef;
}
.pcp-kicker {
  margin: 0 0 8px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.pcp-hero h1 {
  margin: 0;
  font-size: clamp(34px, 6vw, 62px);
  line-height: 0.98;
  letter-spacing: 0;
}
.pcp-description {
  max-width: 760px;
  margin: 18px 0 0;
  color: #475569;
  font-size: 19px;
  line-height: 1.55;
}
.pcp-updated {
  margin: 16px 0 0;
  color: #64748b;
  font-size: 13px;
  font-weight: 700;
}
.pcp-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 180px;
}
.pcp-actions a, .pcp-request-box a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 16px;
  border-radius: 8px;
  font-weight: 850;
  text-decoration: none;
}
.pcp-primary, .pcp-request-box a {
  background: #2563eb;
  color: #fff;
}
.pcp-secondary {
  border: 1px solid #cbd5e1;
  color: #334155;
  background: #fff;
}
.pcp-photo-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 24px 0;
}
.pcp-photo-grid figure {
  margin: 0;
  border-radius: 10px;
  overflow: hidden;
  background: #e2e8f0;
  border: 1px solid #dbe4ef;
}
.pcp-photo-grid img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  display: block;
}
.pcp-photo-grid figcaption {
  padding: 9px 11px;
  color: #475569;
  font-size: 13px;
  line-height: 1.35;
  background: #fff;
}
.pcp-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 28px;
  align-items: start;
  padding: 8px 0 56px;
}
.pcp-main, .pcp-side {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.pcp-section, .pcp-contact, .pcp-request-box {
  padding: 20px 0;
  border-bottom: 1px solid #e2e8f0;
}
.pcp-section h2, .pcp-request-box h2 {
  margin: 0 0 12px;
  font-size: 18px;
  line-height: 1.2;
}
.pcp-section p, .pcp-request-box p {
  margin: 0;
  color: #475569;
  font-size: 15px;
  line-height: 1.6;
}
.pcp-pill-list {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}
.pcp-pill-list span {
  border: 1px solid #cbd5e1;
  background: #fff;
  border-radius: 8px;
  padding: 8px 10px;
  color: #334155;
  font-size: 14px;
  font-weight: 750;
}
.pcp-contact {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pcp-contact div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pcp-contact strong {
  color: #64748b;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.pcp-contact span, .pcp-contact a {
  color: #0f172a;
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.pcp-faq-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pcp-faq-list details {
  border: 1px solid #dbe4ef;
  border-radius: 8px;
  background: #fff;
}
.pcp-faq-list summary {
  cursor: pointer;
  padding: 13px 14px;
  font-weight: 850;
}
.pcp-faq-list details p {
  padding: 0 14px 14px;
}
.pcp-preview {
  padding: 0 14px;
}
@media (max-width: 760px) {
  .pcp-hero, .pcp-layout {
    grid-template-columns: 1fr;
  }
  .pcp-actions {
    min-width: 0;
    flex-direction: row;
    flex-wrap: wrap;
  }
  .pcp-actions a {
    flex: 1 1 140px;
  }
  .pcp-photo-grid {
    grid-template-columns: 1fr;
  }
  .pcp-description {
    font-size: 17px;
  }
}
`;
