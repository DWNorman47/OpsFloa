const router = require('express').Router();
const publicRouter = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const logger = require('../logger');
const { logAudit } = require('../auditLog');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { uploadBase64, deleteByUrl } = require('../r2');
const { checkStorageLimit, incrementStorage, decrementStorage } = require('../storage');

const MAX = {
  displayName: 255,
  shortDescription: 700,
  text: 1600,
  listItems: 30,
  listItem: 160,
  faqItems: 20,
  faqQuestion: 220,
  faqAnswer: 1200,
  photos: 8,
  caption: 220,
};

const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(requireAuth);

function clip(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : '';
}

function cleanList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n|,/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = clip(item, MAX.listItem);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX.listItems) break;
  }
  return out;
}

function cleanContact(value = {}) {
  const websiteRaw = clip(value.website, 300);
  let website = '';
  if (websiteRaw) {
    try {
      const withProtocol = /^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`;
      const url = new URL(withProtocol);
      if (url.protocol === 'http:' || url.protocol === 'https:') website = url.toString();
    } catch {
      website = '';
    }
  }
  return {
    name: clip(value.name, 160),
    email: clip(value.email, 220),
    phone: clip(value.phone, 80),
    website,
    address: clip(value.address, 500),
  };
}

function cleanFaq(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map(item => ({
      question: clip(item?.question, MAX.faqQuestion),
      answer: clip(item?.answer, MAX.faqAnswer),
    }))
    .filter(item => item.question && item.answer)
    .slice(0, MAX.faqItems);
}

function normalizeExistingPhotos(existingPhotos) {
  const map = new Map();
  for (const p of Array.isArray(existingPhotos) ? existingPhotos : []) {
    if (p?.url) map.set(p.url, p);
  }
  return map;
}

function estimateDataUrlBytes(dataUrl) {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) return 0;
  const base64 = String(dataUrl).slice(comma + 1);
  return Math.ceil((base64.length * 3) / 4);
}

async function cleanPhotos(value, companyId, existingPhotos = []) {
  const raw = Array.isArray(value) ? value.slice(0, MAX.photos) : [];
  const estimatedBytes = raw.reduce((sum, item) => {
    const url = String(item?.url || '');
    return url.startsWith('data:') ? sum + estimateDataUrlBytes(url) : sum;
  }, 0);

  if (estimatedBytes > 0) {
    const { allowed, used, limit } = await checkStorageLimit(companyId, estimatedBytes);
    if (!allowed) {
      const usedMb = Math.round(used / (1024 * 1024));
      const limitMb = Math.round(limit / (1024 * 1024));
      const err = new Error(`Storage limit reached (${usedMb} MB of ${limitMb} MB used).`);
      err.status = 413;
      throw err;
    }
  }

  const existingByUrl = normalizeExistingPhotos(existingPhotos);
  const photos = [];
  let uploadedBytes = 0;

  for (const item of raw) {
    const incomingUrl = String(item?.url || '').trim();
    if (!incomingUrl) continue;

    let url = incomingUrl;
    let sizeBytes = Number(item?.size_bytes || item?.sizeBytes || 0) || 0;
    if (incomingUrl.startsWith('data:')) {
      const uploaded = await uploadBase64(incomingUrl, 'public-profiles');
      url = uploaded.url;
      sizeBytes = uploaded.sizeBytes || 0;
      uploadedBytes += sizeBytes;
    } else if (!/^https:\/\//i.test(incomingUrl)) {
      continue;
    } else if (existingByUrl.has(incomingUrl)) {
      sizeBytes = Number(existingByUrl.get(incomingUrl).size_bytes || existingByUrl.get(incomingUrl).sizeBytes || sizeBytes || 0);
    }

    photos.push({
      url,
      caption: clip(item?.caption, MAX.caption),
      alt: clip(item?.alt, MAX.caption),
      size_bytes: sizeBytes,
    });
  }

  if (uploadedBytes > 0) {
    await incrementStorage(companyId, uploadedBytes);
  }

  return { photos, uploadedBytes };
}

function cleanProfileInput(body = {}) {
  return {
    display_name: clip(body.display_name, MAX.displayName),
    short_description: clip(body.short_description, MAX.shortDescription),
    services_offered: cleanList(body.services_offered),
    service_areas: cleanList(body.service_areas),
    license_info: clip(body.license_info, MAX.text),
    equipment_capabilities: cleanList(body.equipment_capabilities),
    project_types: cleanList(body.project_types),
    quote_instructions: clip(body.quote_instructions, MAX.text),
    contact_info: cleanContact(body.contact_info || {}),
    faq_items: cleanFaq(body.faq_items),
  };
}

function rowToProfile(row) {
  return {
    company_id: row.company_id || null,
    slug: row.slug || null,
    company_name: row.company_name || row.name || '',
    display_name: row.display_name || row.company_name || row.name || '',
    short_description: row.short_description || '',
    services_offered: row.services_offered || [],
    service_areas: row.service_areas || [],
    license_info: row.license_info || '',
    equipment_capabilities: row.equipment_capabilities || [],
    project_types: row.project_types || [],
    quote_instructions: row.quote_instructions || '',
    contact_info: row.contact_info || {},
    faq_items: row.faq_items || [],
    photos: row.photos || [],
    is_public: !!row.is_public,
    accepts_service_requests: !!row.accepts_service_requests,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    published_at: row.published_at || null,
  };
}

function rowToPublicProfile(row) {
  const profile = rowToProfile(row);
  delete profile.company_id;
  return profile;
}

async function loadAdminProfile(companyId) {
  const { rows } = await pool.query(
    `SELECT c.id AS company_id, c.name AS company_name, c.slug, c.accepts_service_requests,
            p.display_name, p.short_description, p.services_offered, p.service_areas,
            p.license_info, p.equipment_capabilities, p.project_types, p.quote_instructions,
            p.contact_info, p.faq_items, p.photos, p.is_public, p.created_at, p.updated_at, p.published_at
       FROM companies c
       LEFT JOIN company_public_profiles p ON p.company_id = c.id
      WHERE c.id = $1`,
    [companyId]
  );
  return rows[0] ? rowToProfile(rows[0]) : null;
}

async function saveProfile(req, res, publish = null) {
  const companyId = req.user.company_id;
  let uploadedPhotoUrls = [];
  let uploadedBytes = 0;

  try {
    const current = await loadAdminProfile(companyId);
    if (!current) return res.status(404).json({ error: 'Company not found' });

    const cleaned = cleanProfileInput(req.body);
    const nextPublic = publish == null
      ? (typeof req.body.is_public === 'boolean' ? req.body.is_public : current.is_public)
      : publish;

    if (nextPublic && !cleaned.short_description) {
      return res.status(400).json({ error: 'Add a short description before publishing.' });
    }

    const photoResult = await cleanPhotos(req.body.photos, companyId, current.photos);
    uploadedPhotoUrls = photoResult.photos
      .filter(p => !current.photos.some(old => old.url === p.url))
      .map(p => p.url);
    uploadedBytes = photoResult.uploadedBytes;

    const { rows } = await pool.query(
      `INSERT INTO company_public_profiles
         (company_id, display_name, short_description, services_offered, service_areas,
          license_info, equipment_capabilities, project_types, quote_instructions,
          contact_info, faq_items, photos, is_public, published_at, updated_at)
       VALUES
         ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9,
          $10::jsonb, $11::jsonb, $12::jsonb, $13,
          CASE WHEN $13 THEN COALESCE((SELECT published_at FROM company_public_profiles WHERE company_id = $1), NOW()) ELSE NULL END,
          NOW())
       ON CONFLICT (company_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          short_description = EXCLUDED.short_description,
          services_offered = EXCLUDED.services_offered,
          service_areas = EXCLUDED.service_areas,
          license_info = EXCLUDED.license_info,
          equipment_capabilities = EXCLUDED.equipment_capabilities,
          project_types = EXCLUDED.project_types,
          quote_instructions = EXCLUDED.quote_instructions,
          contact_info = EXCLUDED.contact_info,
          faq_items = EXCLUDED.faq_items,
          photos = EXCLUDED.photos,
          is_public = EXCLUDED.is_public,
          published_at = CASE
            WHEN EXCLUDED.is_public AND company_public_profiles.published_at IS NULL THEN NOW()
            WHEN EXCLUDED.is_public THEN company_public_profiles.published_at
            ELSE NULL
          END,
          updated_at = NOW()
       RETURNING *`,
      [
        companyId,
        cleaned.display_name || null,
        cleaned.short_description || null,
        JSON.stringify(cleaned.services_offered),
        JSON.stringify(cleaned.service_areas),
        cleaned.license_info || null,
        JSON.stringify(cleaned.equipment_capabilities),
        JSON.stringify(cleaned.project_types),
        cleaned.quote_instructions || null,
        JSON.stringify(cleaned.contact_info),
        JSON.stringify(cleaned.faq_items),
        JSON.stringify(photoResult.photos),
        nextPublic,
      ]
    );

    const nextPhotoUrls = new Set(photoResult.photos.map(p => p.url));
    const removedPhotos = current.photos.filter(p => p.url && !nextPhotoUrls.has(p.url));
    for (const photo of removedPhotos) {
      deleteByUrl(photo.url).catch(err => logger.warn({ err, url: photo.url }, 'public_profile_photo_delete_failed'));
      const size = Number(photo.size_bytes || photo.sizeBytes || 0);
      if (size > 0) decrementStorage(companyId, size).catch(() => {});
    }

    const profile = rowToProfile({
      ...rows[0],
      company_name: current.company_name,
      slug: current.slug,
      accepts_service_requests: current.accepts_service_requests,
    });

    await logAudit(
      companyId,
      req.user.id,
      req.user.full_name,
      nextPublic ? 'company_public_profile.published' : 'company_public_profile.saved',
      'company',
      companyId,
      profile.display_name
    );

    res.json({ profile });
  } catch (err) {
    for (const url of uploadedPhotoUrls) {
      deleteByUrl(url).catch(() => {});
    }
    if (uploadedBytes > 0) decrementStorage(companyId, uploadedBytes).catch(() => {});
    logger.error({ err }, 'company public profile save error');
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
  }
}

router.get('/', requirePerm('manage_settings'), async (req, res) => {
  try {
    const profile = await loadAdminProfile(req.user.company_id);
    if (!profile) return res.status(404).json({ error: 'Company not found' });
    res.json({ profile });
  } catch (err) {
    logger.error({ err }, 'company public profile load error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/', requirePerm('manage_settings'), (req, res) => saveProfile(req, res));

router.post('/publish', requirePerm('manage_settings'), (req, res) => saveProfile(req, res, true));

router.post('/unpublish', requirePerm('manage_settings'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE company_public_profiles
          SET is_public = false, published_at = NULL, updated_at = NOW()
        WHERE company_id = $1
        RETURNING *`,
      [req.user.company_id]
    );
    const current = await loadAdminProfile(req.user.company_id);
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'company_public_profile.unpublished', 'company', req.user.company_id, current?.display_name || null);
    res.json({ profile: current || rowToProfile(rows[0] || {}) });
  } catch (err) {
    logger.error({ err }, 'company public profile unpublish error');
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.use(publicReadLimiter);

publicRouter.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id AS company_id, c.name AS company_name, c.slug, c.accepts_service_requests,
              p.display_name, p.short_description, p.services_offered, p.service_areas,
              p.license_info, p.equipment_capabilities, p.project_types, p.quote_instructions,
              p.contact_info, p.faq_items, p.photos, p.is_public, p.created_at, p.updated_at, p.published_at
         FROM companies c
         JOIN company_public_profiles p ON p.company_id = c.id
        WHERE c.slug = $1
          AND c.active = true
          AND p.is_public = true
          AND NOT EXISTS (
            SELECT 1 FROM settings se
             WHERE se.company_id = c.id AND se.key = 'feature_public' AND se.value = '0'
          )`,
      [req.params.slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company profile not found' });
    res.json({ profile: rowToPublicProfile(rows[0]) });
  } catch (err) {
    logger.error({ err }, 'public company profile error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
