import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import PublicCompanyProfileView from '../components/PublicCompanyProfileView';

function useJsonLd(profile) {
  useEffect(() => {
    if (!profile) return undefined;
    const name = profile.display_name || profile.company_name;
    const contact = profile.contact_info || {};
    const url = window.location.href;
    const schema = [
      {
        '@context': 'https://schema.org',
        '@type': 'LocalBusiness',
        name,
        description: profile.short_description || undefined,
        url,
        telephone: contact.phone || undefined,
        email: contact.email || undefined,
        address: contact.address || undefined,
        areaServed: profile.service_areas || undefined,
        knowsAbout: [
          ...(profile.services_offered || []),
          ...(profile.project_types || []),
          ...(profile.equipment_capabilities || []),
        ],
        image: (profile.photos || []).map(photo => photo.url),
        sameAs: contact.website ? [contact.website] : undefined,
      },
      profile.faq_items?.length ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: profile.faq_items.map(item => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: item.answer,
          },
        })),
      } : null,
    ].filter(Boolean);

    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.dataset.opsfloaProfileJsonLd = 'true';
    el.text = JSON.stringify(schema);
    document.head.appendChild(el);
    return () => el.remove();
  }, [profile]);
}

export default function PublicCompanyProfilePage() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setError('');
    api.get(`/public/company-profiles/${slug}`, { suppressToast: true })
      .then(r => setProfile(r.data.profile))
      .catch(err => {
        if (err.response?.status === 404) setNotFound(true);
        else setError(getT(detectLanguage(profile?.client_language || profile?.language)).pcpLoadError);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  // No logged-in user here — render in the client's stored language when known,
  // otherwise the visitor's browser language.
  const language = detectLanguage(profile?.client_language || profile?.language);
  const t = getT(language);

  const title = profile?.display_name || profile?.company_name || t.pcpCompanyProfile;
  const description = useMemo(() => {
    if (profile?.short_description) return profile.short_description;
    return `${t.pcpMetaDescriptionPrefix} ${title}.`;
  }, [profile?.short_description, title, t]);

  useDocumentMeta({
    title: profile ? `${title} | ${t.pcpCompanyProfile}` : t.pcpCompanyProfile,
    description,
    robots: notFound ? 'noindex' : undefined,
  });
  useJsonLd(profile);

  if (loading) return <div style={styles.center}>{t.pcpLoading}</div>;

  if (notFound) {
    return (
      <main style={styles.page}>
        <section style={styles.messageCard}>
          <h1>{t.pcpNotFoundTitle}</h1>
          <p>{t.pcpNotFoundBody}</p>
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main style={styles.page}>
        <section style={styles.messageCard}>
          <h1>{t.pcpErrorTitle}</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <PublicCompanyProfileView profile={profile} language={language} t={t} />
    </main>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f8fafc',
    padding: '0 24px',
  },
  center: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#64748b',
    background: '#f8fafc',
    fontSize: 15,
  },
  messageCard: {
    maxWidth: 560,
    margin: '0 auto',
    padding: '72px 0',
    color: '#0f172a',
  },
};
