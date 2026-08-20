// Fixed-value set for client_documents.doc_type. Single source of truth shared by the
// app validators; the DB CHECK (migration 0191) and docs/db-enums.md must match this list.
const CLIENT_DOCUMENT_TYPES = Object.freeze(['w9', 'w2', 'coi', 'contract', 'license', 'other']);
const CLIENT_DOCUMENT_TYPE_DEFAULT = 'other';

module.exports = { CLIENT_DOCUMENT_TYPES, CLIENT_DOCUMENT_TYPE_DEFAULT };
