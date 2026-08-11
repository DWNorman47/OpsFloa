import React, { useState, useEffect } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import Pagination from './Pagination';
import { SkeletonList, SkeletonBlock } from './Skeleton';
import FieldFilters from './FieldFilters';
import { labelSg, labelPl } from '../companyLabels';

const TALK_LIBRARY = [
  { title: 'Fall Protection', content: 'Key Points:\n• Workers at 6 ft or more must be protected from falls\n• Fall protection methods: guardrails, safety nets, personal fall arrest systems (PFAS)\n• Inspect all harnesses and lanyards before each use — retire any that has been in a fall\n• Keep work areas clear of tripping hazards\n\nHazards to watch for:\n• Unprotected floor openings and roof edges without guardrails\n• Scaffolding without toe boards\n\nAction: Report missing or damaged fall protection immediately. Do not work at heights without protection in place.' },
  { title: 'Ladder Safety', content: 'Key Points:\n• Inspect ladders before each use — discard damaged ladders\n• Set extension ladders at a 4:1 ratio (1 ft out for every 4 ft of height)\n• Ladder must extend 3 ft above the landing\n• Always face the ladder and maintain 3 points of contact\n• Never stand on the top two rungs\n• Do not carry tools in your hands while climbing\n\nHazards:\n• Ladders on unstable or slippery surfaces\n• Overreaching to the side\n• Metal ladders near electrical hazards' },
  { title: 'Personal Protective Equipment (PPE)', content: 'Required PPE for this work: use the protective equipment assigned for your role and task.\n\nKey Points:\n• Inspect all PPE before each use — replace damaged equipment\n• Wear the right PPE for the task (gloves, face shields, hearing protection as required)\n• Ensure PPE fits correctly — ill-fitting PPE is ineffective\n\nCommon failures:\n• Hard hats worn backwards (reduces protection)\n• Safety glasses removed in dusty or flying debris areas\n• Gloves worn near rotating machinery — entanglement hazard' },
  { title: 'Lockout/Tagout (LOTO)', content: 'NEVER perform maintenance on equipment that could accidentally energize.\n\nSteps:\n1. Notify affected workers\n2. Identify all energy sources\n3. Shut down the equipment\n4. Isolate energy sources\n5. Apply your personal lock and tag\n6. Release/restrain stored energy\n7. Verify zero energy state before starting work\n\nKey rule:\n• Each worker applies their own lock — never rely on someone else\'s\n• Only the worker who applied the lock may remove it\n• Energy types: electrical, hydraulic, pneumatic, mechanical, thermal, chemical' },
  { title: 'Electrical Safety', content: 'Key Points:\n• Treat all electrical wires as live until verified otherwise\n• Maintain at least 10 ft clearance from overhead power lines\n• Use GFCIs on all temporary power cords\n• Inspect extension cords daily — remove any with damaged insulation\n• Do not bypass or remove safety devices\n• Never use electrical equipment in wet conditions\n\nHazards:\n• Overhead and underground power lines\n• Overloaded circuits and extension cords' },
  { title: 'Struck-By Hazards', content: 'Struck-by incidents are a serious risk anywhere people work around vehicles, tools, equipment, or stored materials.\nFour types: flying, falling, swinging, and rolling objects.\n\nKey Precautions:\n• Wear high-visibility vests near vehicle traffic\n• Never stand under suspended loads\n• Establish exclusion zones around crane and rigging operations\n• Secure all tools and materials at height — use toe boards and tool lanyards\n• Know the blind spots of all heavy equipment\n• Make eye contact with operators before approaching' },
  { title: 'Trenching & Excavation Safety', content: 'Key Points:\n• All excavations 5 ft or deeper require a protective system (shoring, sloping, or trench box)\n• A competent person must inspect the trench daily and after rain\n• Never enter an unprotected trench\n• Test air quality before entry if deeper than 4 ft (O₂, flammable gas, toxic gas)\n\nFatality hazards:\n• Cave-in — most common cause of trench fatalities\n• Flooding — never enter a flooded trench\n• Falling loads — stay away from the edge\n\nEmergency: Know the location of rescue equipment before entering.' },
  { title: 'Heat Illness Prevention', content: 'Heat illness can become life-threatening quickly. Know the warning signs.\n\nPrevention:\n• Drink water frequently — at least 1 cup every 20 minutes\n• Take rest breaks in shade or air conditioning\n• Acclimatize new workers gradually in their first 1-2 weeks\n• Buddy system — watch for signs in coworkers\n\nHeat Exhaustion:\n• Heavy sweating, weakness, cool/pale/clammy skin, headache, nausea\n• Move to cool area, rest, rehydrate\n\nHeat Stroke — call 911 immediately:\n• High body temp (103°F+), hot dry skin, confusion, loss of consciousness\n• Cool the victim while waiting for help' },
  { title: 'Hand & Power Tool Safety', content: 'Key Points:\n• Inspect all tools before use — do not use damaged tools\n• Use the right tool for the job — never modify or improvise\n• Keep guards in place at all times\n• Disconnect power before adjusting, changing blades, or clearing jams\n• Never carry a tool by the cord or yank the cord to disconnect\n\nCutting tools:\n• Keep blades sharp — dull blades require more force and slip more easily\n• Cut away from your body\n\nPower tools:\n• Secure workpieces so they don\'t move\n• Keep bystanders clear of the work area' },
  { title: 'Scaffolding Safety', content: 'Key Points:\n• Scaffolding must be erected by trained workers only\n• Never exceed the scaffold\'s rated load capacity\n• All platforms must be fully planked — no gaps greater than 1 inch\n• Guardrails required when platform is 10 ft or more above ground\n• Toe boards required to prevent tools from falling\n\nBefore each shift:\n• Competent person must inspect the scaffold\n• Check footings, frames, bracing, planks, and guardrails\n\nWeather:\n• Do not work on scaffolding during high winds, ice, or lightning' },
  { title: 'Hazard Communication (HazCom / GHS)', content: 'Every worker has the right to know about hazardous chemicals at the work location.\n\nKey Points:\n• Safety Data Sheets (SDS) must be available for all chemicals\n• All containers must be properly labeled — never remove or deface labels\n• GHS label elements: product identifier, signal word, hazard statements, pictograms, precautionary statements\n\nBefore using a new chemical:\n• Read the SDS — Sections 2 (Hazards), 7 (Handling), 8 (PPE)\n\nSpill response:\n• Know the location of spill kits and eyewash stations\n• Follow SDS instructions for cleanup' },
  { title: 'Fire Prevention & Extinguisher Use', content: 'Know the location of fire extinguishers at the work location. Keep exits clear.\n\nPrevention:\n• Store flammables in approved containers away from ignition sources\n• No open flames near fueling areas\n\nUsing a fire extinguisher — PASS:\n• Pull the pin\n• Aim at the base of the fire\n• Squeeze the handle\n• Sweep side to side\n\nKnow when to fight vs. evacuate:\n• Only fight small, contained fires\n• If fire blocks your exit, spreads rapidly, or produces heavy smoke — evacuate and call 911' },
  { title: 'Back Safety & Safe Lifting', content: 'Back injuries are among the most common and costly workplace injuries. Plan the lift first.\n\nProper lifting technique:\n• Stand close to the load\n• Bend at the knees and hips — not the back\n• Get a firm grip\n• Lift with your legs, back straight\n• Keep the load close to your body\n• Turn with your feet — never twist at the waist\n\nTeam lifts:\n• Use a team for loads over 50 lbs or awkward shapes\n• One person calls the movement\n\nMechanical aids:\n• Use dollies, carts, and forklifts whenever possible' },
  { title: 'Eye & Face Protection', content: 'Eye injuries can cause permanent vision loss.\n\nChoose the right protection:\n• Flying debris: safety glasses or goggles\n• Chemical splash: chemical splash goggles\n• Grinding/cutting: face shield over safety glasses\n• Welding: welding helmet with appropriate shade\n\nKey rules:\n• Safety glasses required in all designated areas\n• Contact lens wearers must still wear safety glasses or goggles\n• Ensure eyewear fits — gaps allow debris to enter\n\nFirst aid:\n• Flush eyes with clean water for 15-20 minutes for chemical exposure\n• Seek medical attention for penetrating injuries — do not rub the eye' },
  { title: 'Silica Dust Safety', content: 'Crystalline silica is found in concrete, brick, mortar, sand, and stone. Cutting, drilling, grinding, or crushing releases hazardous dust that can cause silicosis — an irreversible and fatal lung disease.\n\nControls (use in order):\n• Water suppression — wet cutting, wet drilling\n• Local exhaust ventilation (LEV) with HEPA filtration\n• Equipment with integrated wet suppression or vacuum systems\n\nPPE (when engineering controls are insufficient):\n• N95 respirator at minimum — must be fit-tested\n\nKey rule:\n• No dry sweeping — use wet methods or HEPA vacuums' },
  { title: 'Caught-In/Between Hazards', content: 'Caught-in/between injuries can happen around moving equipment, pinch points, doors, vehicles, shelving, and machinery.\nHazards include rotating equipment, compression points, cave-ins, and tight spaces between equipment and fixed objects.\n\nKey Precautions:\n• Keep all machine guards in place\n• Never reach into moving equipment\n• Stay clear of equipment swing radius\n• Tie back long hair; avoid loose clothing near rotating parts\n• Do not stand between moving equipment and a fixed object\n• Use spotters when equipment operates near people — spotter stays in operator\'s line of sight' },
  { title: 'Confined Space Entry', content: 'A permit-required confined space has: hazardous atmosphere, engulfment hazard, converging internal shape, or another serious hazard.\nExamples: manholes, tanks, vaults, large pipes.\n\nBefore entry:\n• Written entry permit required\n• Test atmosphere: O₂ (19.5–23.5%), flammable gases (<10% LEL), toxic gases\n• Establish ventilation if needed\n• Assign a hole watch (attendant) who stays outside\n• Establish a rescue plan\n\nDuring entry:\n• Continuous atmospheric monitoring\n• Maintain communication with attendant at all times\n\nEmergency: Attendants do not enter — they call for rescue.' },
  { title: 'Forklift Safety', content: 'Only licensed/certified operators may operate forklifts.\n\nKey Points:\n• Inspect the forklift before each shift\n• Never exceed the rated load capacity\n• Carry loads 4-6 inches off the ground while traveling\n• Travel with forks tilted back for stability\n• Slow down and sound horn at intersections and blind corners\n• Never raise or lower loads while traveling\n• Keep pedestrians out of the operating area\n• No passengers unless a designated seat is provided\n\nStability:\n• Overloading or uneven loads can tip the machine\n• If tipping: stay in the seat, hold on, lean away from the fall direction' },
  { title: 'First Aid & Emergency Response', content: `Emergency number: 911\nWork location address: _______________\nNearest hospital: _______________\nSupervisor emergency contact: _______________\nAssembly point: _______________\n\nLocation of:\n• First aid kits: _______________\n• Eyewash stations: _______________\n• AED (if at the work location): _______________\n\nBasic first aid:\n• Cuts/bleeding: apply direct pressure with clean cloth\n• Burns: cool with running water for 10+ minutes\n• Eye injuries: flush with clean water for 15-20 minutes\n• Suspected fractures: immobilize and wait for EMS\n• Do not move a seriously injured worker\n\nCPR/AED:\n• Begin CPR if trained and victim has no pulse\n• Use AED as soon as available — it guides you through the steps` },
];

function fmtDate(str, locale = 'en-US') {
  if (!str) return 'No date';
  const datePart = String(str).includes('T') ? String(str).slice(0, 10) : String(str);
  const date = new Date(`${datePart}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'No date';
  return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

const TALK_ACCENTS = ['#059669', '#2563eb', '#7c3aed', '#dc2626', '#d97706', '#0891b2'];

function talkAccent(title = '') {
  const text = String(title || '');
  const hash = Array.from(text).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return TALK_ACCENTS[hash % TALK_ACCENTS.length];
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileIcon(contentType) {
  if (!contentType) return '📎';
  if (contentType.startsWith('image/')) return '🖼️';
  if (contentType === 'application/pdf') return '📄';
  if (contentType.includes('word')) return '📝';
  if (contentType.includes('sheet') || contentType.includes('excel')) return '📊';
  return '📎';
}

function NewTalkForm({ projects, onAdded, onCancel, defaultProjectId = null }) {
  const t = useT();
  const today = new Date().toLocaleDateString('en-CA');
  const [form, setForm] = useState({ title: '', content: '', given_by: '', talk_date: today, project_id: defaultProjectId ? String(defaultProjectId) : '' });
  const [questions, setQuestions] = useState([]);
  const [passThreshold, setPassThreshold] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const pickFromLibrary = (topic) => {
    setForm(f => ({ ...f, title: topic.title, content: topic.content }));
    setShowLibrary(false);
  };

  const addQuestion = () => setQuestions(q => [...q, { question: '', options: ['', ''], correct_index: 0 }]);
  const removeQuestion = i => setQuestions(q => q.filter((_, idx) => idx !== i));
  const setQuestion = (i, text) => setQuestions(q => q.map((x, idx) => idx === i ? { ...x, question: text } : x));
  const setOption = (qi, oi, text) => setQuestions(q => q.map((x, idx) => idx === qi ? { ...x, options: x.options.map((o, j) => j === oi ? text : o) } : x));
  const addOption = i => setQuestions(q => q.map((x, idx) => idx === i && x.options.length < 4 ? { ...x, options: [...x.options, ''] } : x));
  const removeOption = (qi, oi) => setQuestions(q => q.map((x, idx) => {
    if (idx !== qi) return x;
    const opts = x.options.filter((_, j) => j !== oi);
    return { ...x, options: opts, correct_index: Math.min(x.correct_index, opts.length - 1) };
  }));
  const setCorrect = (qi, oi) => setQuestions(q => q.map((x, idx) => idx === qi ? { ...x, correct_index: oi } : x));

  const submit = async e => {
    e.preventDefault();
    if (!form.title.trim()) { setError(t.titleRequired); return; }
    for (let i = 0; i < questions.length; i++) {
      if (!questions[i].question.trim()) { setError(t.quizQuestionMissingText.replace('{n}', i + 1)); return; }
      if (questions[i].options.filter(o => o.trim()).length < 2) { setError(t.quizQuestionNeedsOptions.replace('{n}', i + 1)); return; }
    }
    setSaving(true); setError('');
    try {
      const r = await api.post('/safety-talks', {
        ...form,
        questions,
        pass_threshold: passThreshold !== '' ? parseInt(passThreshold) : null,
      });
      if (r.data?.offline) {
        onAdded({ id: 'pending-' + Date.now(), pending: true, ...form, signoff_count: 0, question_count: 0 });
      } else {
        onAdded(r.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} style={styles.form}>
      <div style={styles.formTitleRow}>
        <h3 style={styles.formTitle}>{t.newTalkFormTitle}</h3>
        <button type="button" style={styles.libraryBtn} onClick={() => setShowLibrary(s => !s)}>
          📚 {showLibrary ? t.hideLibrary : t.fromLibrary}
        </button>
      </div>

      {showLibrary && (
        <div style={styles.libraryGrid}>
          {TALK_LIBRARY.map(t => (
            <button key={t.title} type="button" style={styles.libraryTopic} onClick={() => pickFromLibrary(t)}>
              {t.title}
            </button>
          ))}
        </div>
      )}

      <div style={styles.formGrid}>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <label htmlFor="st-title" style={styles.label}>{t.topicTitle}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
          <input id="st-title" style={styles.input} type="text" maxLength={200} placeholder={t.safetyTalkTitlePlaceholder} value={form.title} onChange={e => set('title', e.target.value)} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="st-date" style={styles.label}>{t.date}</label>
          <input id="st-date" style={styles.input} type="date" value={form.talk_date} onChange={e => set('talk_date', e.target.value)} />
        </div>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label htmlFor="st-project" style={styles.label}>Project</label>
            <select id="st-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No project`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div style={styles.fieldGroup}>
          <label htmlFor="st-given-by" style={styles.label}>{t.givenBy}</label>
          <input id="st-given-by" style={styles.input} type="text" maxLength={255} placeholder={t.givenByPlaceholder} value={form.given_by} onChange={e => set('given_by', e.target.value)} />
        </div>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label htmlFor="st-content" style={styles.label}>{t.talkContent}</label>
            <span style={styles.charCount}>{form.content.length}/5000</span>
          </div>
          <textarea id="st-content" style={styles.textarea} rows={5} maxLength={5000} placeholder={t.talkContentPlaceholder} value={form.content} onChange={e => set('content', e.target.value)} />
        </div>
      </div>

      {/* Quiz Questions */}
      <div style={styles.quizSection}>
        <div style={styles.quizSectionHead}>
          <div>
            <div style={styles.quizSectionTitle}>{t.quizQuestionsTitle} <span style={styles.optional}>{t.quizOptional}</span></div>
            <div style={styles.quizSectionSub}>{t.quizDesc}</div>
          </div>
          <button type="button" style={styles.addQuestionBtn} onClick={addQuestion}>+ {t.addQuestion}</button>
        </div>

        {questions.map((q, qi) => (
          <div key={qi} style={styles.questionCard}>
            <div style={styles.questionHeader}>
              <span style={styles.questionNum}>Q{qi + 1}</span>
              <input
                style={{ ...styles.input, flex: 1 }}
                type="text"
                placeholder={t.questionTextPlaceholder}
                value={q.question}
                onChange={e => setQuestion(qi, e.target.value)}
              />
              <button type="button" style={styles.removeQuestionBtn} aria-label={t.removeQuestion} onClick={() => removeQuestion(qi)}>✕</button>
            </div>
            <div style={styles.optionsList}>
              {q.options.map((opt, oi) => (
                <div key={oi} style={styles.optionRow}>
                  <input
                    type="radio"
                    name={`correct-${qi}`}
                    checked={q.correct_index === oi}
                    onChange={() => setCorrect(qi, oi)}
                    title={t.markCorrectAnswer}
                  />
                  <input
                    style={{ ...styles.input, flex: 1 }}
                    type="text"
                    placeholder={`Option ${oi + 1}`}
                    value={opt}
                    onChange={e => setOption(qi, oi, e.target.value)}
                  />
                  {q.options.length > 2 && (
                    <button type="button" style={styles.removeOptionBtn} aria-label={t.removeOption} onClick={() => removeOption(qi, oi)}>✕</button>
                  )}
                </div>
              ))}
              {q.options.length < 4 && (
                <button type="button" style={styles.addOptionBtn} onClick={() => addOption(qi)}>+ {t.addOption}</button>
              )}
            </div>
          </div>
        ))}

        {questions.length > 0 && (
          <div style={styles.thresholdRow}>
            <label htmlFor="st-threshold" style={styles.label}>{t.passIfAtLeast}</label>
            <input
              id="st-threshold"
              style={{ ...styles.input, width: 64, textAlign: 'center' }}
              type="number"
              min={1}
              max={questions.length}
              placeholder={String(questions.length)}
              value={passThreshold}
              onChange={e => setPassThreshold(e.target.value)}
            />
            <label style={styles.label}>{t.ofCorrect} ({questions.length})</label>
          </div>
        )}
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : t.createTalk}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

function TalkCard({ talk: initialTalk, isAdmin, onDeleted, workerLabelPlural = 'Workers' }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [talk, setTalk] = useState(initialTalk);
  const [expanded, setExpanded] = useState(false);
  const [signing, setSigning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [signoffs, setSignoffs] = useState(null);
  const [questions, setQuestions] = useState(null);
  const [attachments, setAttachments] = useState(null);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizResult, setQuizResult] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [pendingDeleteAttachId, setPendingDeleteAttachId] = useState(null);
  const [attachDeleteError, setAttachDeleteError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const fileInputRef = React.useRef(null);

  const loadDetail = async () => {
    try {
      const r = await api.get(`/safety-talks/${talk.id}`);
      setSignoffs(r.data.signoffs || []);
      setQuestions(r.data.questions || []);
      setAttachments(r.data.attachments || []);
    } catch {
      setSignoffs([]);
      setQuestions([]);
      setAttachments([]);
    }
  };

  const handleAttachmentUpload = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      const { uploadUrl, publicUrl } = (await api.get('/safety-talks/attachment-upload-url', {
        params: { ext, type: file.type },
      })).data;
      await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      const r = await api.post(`/safety-talks/${talk.id}/attachments`, {
        name: file.name,
        url: publicUrl,
        content_type: file.type,
        size_bytes: file.size,
      });
      setAttachments(prev => [...(prev || []), r.data]);
    } catch { setUploadError(t.uploadFailed); }
    finally { setUploading(false); }
  };

  const deleteAttachment = async attId => {
    setAttachDeleteError('');
    try {
      await api.delete(`/safety-talks/${talk.id}/attachments/${attId}`);
      setAttachments(prev => prev.filter(a => a.id !== attId));
      setPendingDeleteAttachId(null);
    } catch { setAttachDeleteError(t.failedRemoveAttachment); setPendingDeleteAttachId(null); }
  };

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && signoffs === null) loadDetail();
  };

  const alreadySigned = signoffs?.some(s => s.worker_id === user?.id);
  const hasQuiz = parseInt(talk.question_count) > 0;
  const allAnswered = questions?.length > 0 && questions.every((_, i) => quizAnswers[i] !== undefined);

  const handleSignoff = async () => {
    setSigning(true);
    try {
      const answers = questions?.length > 0 ? questions.map((_, i) => quizAnswers[i]) : undefined;
      const r = await api.post(`/safety-talks/${talk.id}/signoff`, answers ? { answers } : {});
      if (r.data.quiz_failed) {
        setQuizResult({ passed: false, score: r.data.score, needed: r.data.needed, total: r.data.total });
        return;
      }
      setQuizResult(r.data.quiz_score != null ? { passed: true, score: r.data.quiz_score, total: questions.length } : null);
      await loadDetail();
      setTalk(t => ({ ...t, signoff_count: parseInt(t.signoff_count) + 1 }));
    } finally { setSigning(false); }
  };

  const handleDelete = async () => {
    setDeleteError('');
    setDeleting(true);
    try { await api.delete(`/safety-talks/${talk.id}`); onDeleted(talk.id); }
    catch { setDeleteError(t.failedToDelete); setConfirmingDelete(false); }
    finally { setDeleting(false); }
  };

  const needed = talk.pass_threshold ?? parseInt(talk.question_count);

  return (
    <div style={{ ...styles.card, borderLeft: `4px solid ${talkAccent(talk.title)}` }}>
      <div style={styles.cardHeader} onClick={handleExpand} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && handleExpand()}>
        <div style={styles.cardLeft}>
          <div>
            <div style={styles.talkTitle}>{talk.title}{talk.pending && <span style={styles.pendingBadge}>⏳ {t.pendingSync}</span>}</div>
            <div style={styles.talkMeta}>
              {fmtDate(talk.talk_date, locale)}
              {talk.project_name && <span style={styles.projectTag}>{talk.project_name}</span>}
              {talk.given_by && <span style={styles.givenBy}>{t.talkGivenBy} {talk.given_by}</span>}
              {hasQuiz && <span style={styles.quizBadge}>Quiz: {talk.question_count} question{talk.question_count !== '1' ? 's' : ''}</span>}
            </div>
          </div>
        </div>
        <div style={styles.cardRight}>
          <span style={styles.signoffBadge} title={`${workerLabelPlural} signed`}>{talk.signoff_count}</span>
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {talk.content && <p style={styles.content}>{talk.content}</p>}

          {/* Admin: show questions with correct answers */}
          {isAdmin && questions?.length > 0 && (
            <div style={styles.adminQuizPreview}>
              <div style={styles.quizPreviewTitle}>Quiz ({questions.length} question{questions.length !== 1 ? 's' : ''}, pass if {needed}/{questions.length} correct)</div>
              {questions.map((q, i) => (
                <div key={i} style={styles.adminQuestion}>
                  <div style={styles.adminQuestionText}>{i + 1}. {q.question}</div>
                  {q.options.map((opt, oi) => (
                    <div key={oi} style={{ ...styles.adminOption, ...(oi === q.correct_index ? styles.adminOptionCorrect : {}) }}>
                      {oi === q.correct_index ? 'Correct: ' : ''}{opt}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Worker: quiz before sign-off */}
          {!isAdmin && !alreadySigned && questions?.length > 0 && (
            <div style={styles.quizBox}>
              <div style={styles.quizTitle}>Quiz - answer to sign off ({needed}/{questions.length} correct to pass)</div>
              {questions.map((q, i) => (
                <div key={i} style={styles.quizQuestion}>
                  <div style={styles.quizQuestionText}>{i + 1}. {q.question}</div>
                  {q.options.map((opt, oi) => (
                    <label key={oi} style={styles.quizOption}>
                      <input
                        type="radio"
                        name={`q${talk.id}-${i}`}
                        checked={quizAnswers[i] === oi}
                        onChange={() => { setQuizAnswers(a => ({ ...a, [i]: oi })); setQuizResult(null); }}
                      />
                      <span style={styles.quizOptionText}>{opt}</span>
                    </label>
                  ))}
                </div>
              ))}
              {quizResult && !quizResult.passed && (
                <div style={styles.quizFail}>
                  {quizResult.score}/{quizResult.total} {t.quizFailedMsg} {quizResult.needed} {t.quizFailedTryAgain}
                </div>
              )}
            </div>
          )}

          {quizResult?.passed && (
            <div style={styles.quizPass}>{quizResult.score}/{quizResult.total} {t.quizPassedMsg}</div>
          )}

          {/* Attachments */}
          {((attachments && attachments.length > 0) || isAdmin) && (
            <div style={styles.attachmentsSection}>
              <div style={styles.attachmentsHeader}>
                <span style={styles.attachmentsTitle}>{t.attachmentsSection}</span>
                {isAdmin && (
                  <>
                    <button style={{ ...styles.attachBtn, ...(uploading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                      {uploading ? t.uploading : `+ ${t.attachFile}`}
                    </button>
                    <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleAttachmentUpload} />
                  </>
                )}
              </div>
              {uploadError && <p role="alert" style={styles.error}>{uploadError}</p>}
              {attachDeleteError && <p role="alert" style={styles.error}>{attachDeleteError}</p>}
              {attachments === null ? (
                <SkeletonBlock width="100%" height={36} style={{ marginTop: 8 }} />
              ) : attachments.length === 0 ? (
                <p style={styles.hint}>{t.noAttachments}</p>
              ) : (
                <div style={styles.attachmentList}>
                  {attachments.map(a => (
                    <div key={a.id} style={styles.attachmentRow}>
                      <span style={styles.attachIcon}>{fileIcon(a.content_type)}</span>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" style={styles.attachName} title={a.name}>{a.name}</a>
                      {a.size_bytes && <span style={styles.attachSize}>{formatBytes(a.size_bytes)}</span>}
                      {isAdmin && (pendingDeleteAttachId === a.id ? (
                        <>
                          <button style={styles.confirmDeleteBtn} onClick={() => deleteAttachment(a.id)}>{t.confirm}</button>
                          <button style={styles.attachCancelBtn} onClick={() => setPendingDeleteAttachId(null)}>{t.cancel}</button>
                        </>
                      ) : (
                        <button style={styles.attachDeleteBtn} aria-label={t.deleteAttachment} onClick={() => setPendingDeleteAttachId(a.id)}>✕</button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={styles.signoffSection}>
            <div style={styles.signoffHeader}>
              <span style={styles.signoffTitle}>{t.signoffsLabel} ({signoffs?.length ?? talk.signoff_count})</span>
              {!isAdmin && !alreadySigned && (
                <button
                  style={{ ...styles.signBtn, ...((signing || (questions?.length > 0 && !allAnswered)) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                  onClick={handleSignoff}
                  disabled={signing || (questions?.length > 0 && !allAnswered)}
                  title={questions?.length > 0 && !allAnswered ? t.answerQuestionsFirst : ''}
                >
                  {signing ? t.saving : t.signOff}
                </button>
              )}
              {!isAdmin && alreadySigned && (
                <span style={styles.signedNote}>✓ {t.alreadySigned}</span>
              )}
            </div>
            {signoffs === null ? (
              <SkeletonBlock width="60%" height={24} style={{ marginTop: 6 }} />
            ) : signoffs.length === 0 ? (
              <p style={styles.hint}>{t.noSignoffs}</p>
            ) : (
              <div style={styles.signoffList}>
                {signoffs.map((s, i) => (
                  <span key={i} style={styles.signoffChip}>
                    {s.full_name || s.worker_name}
                    {s.quiz_score != null && <span style={styles.quizScore}>{s.quiz_score}/{questions?.length ?? '?'}</span>}
                    <span style={styles.signoffTime}>
                      {new Date(s.signed_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {isAdmin && (
            <div style={styles.cardActions}>
              {confirmingDelete ? (
                <>
                  <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? t.saving : t.confirm}</button>
                  <button style={styles.cancelBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
                </>
              ) : (
                <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.delete}</button>
              )}
              {deleteError && <p role="alert" style={{ ...styles.error, margin: 0 }}>{deleteError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SafetyTalks({ projects, settings = null, activeProject = '', onProjectChange }) {
  const t = useT();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const [talks, setTalks] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filterProject, setFilterProject] = useState(activeProject != null ? String(activeProject) : '');
  useEffect(() => { setFilterProject(activeProject != null ? String(activeProject) : ''); }, [activeProject]);
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { SafetyTalkDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./SafetyTalkPDF'),
      ]);
      const blob = await pdf(React.createElement(SafetyTalkDocument, { talks, companyName: user?.company_name, language: user?.language })).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'safety-talks.pdf'; a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };

  const load = async (proj = filterProject, p = 1) => {
    setPage(p);
    try {
      const params = { page: p, limit: 50 };
      if (proj) params.project_id = proj;
      const r = await api.get('/safety-talks', { params });
      setTalks(r.data.items);
      setTotalPages(r.data.pages);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (!loading) load(filterProject, 1); }, [filterProject]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) load(filterProject, page); }); }, [onSync]);

  const totalSignoffs = talks.reduce((s, t) => s + parseInt(t.signoff_count || 0), 0);

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h2 style={styles.heading}>{t.safetyTalksTitle}</h2>
          {talks.length > 0 && (
            <p style={styles.summary}>{talks.length} {talks.length !== 1 ? t.talksCountPlural : t.talksCount} · {totalSignoffs} {t.totalSignoffs}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {talks.length > 0 && <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>{pdfGenerating ? t.preparing : t.exportPDF}</button>}
          {isAdmin && <button style={styles.newBtn} onClick={() => setShowForm(true)}>{t.newTalk}</button>}
        </div>
      </div>

      {showForm && (
        <div style={styles.formCard}>
          <NewTalkForm
            projects={projects}
            defaultProjectId={activeProject}
            onAdded={talk => { setTalks(prev => [talk, ...prev]); setShowForm(false); }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {projects.length > 0 && (
        <FieldFilters activeCount={filterProject ? 1 : 0}>
          <select style={styles.filterSelect} value={filterProject} onChange={e => { setFilterProject(e.target.value); onProjectChange?.(e.target.value); }}>
            <option value="">{`All Projects`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </FieldFilters>
      )}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : talks.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyText}>
            {isAdmin ? t.noTalksAdmin : t.noTalksWorker}
          </p>
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {talks.map(t => (
              <TalkCard
                key={t.id}
                talk={t}
                isAdmin={isAdmin}
                workerLabelPlural={workerLabelPlural}
                onDeleted={id => setTalks(prev => prev.filter(t => t.id !== id))}
              />
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => load(filterProject, p)} />
        </>
      )}
    </div>
  );
}

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  pdfBtn: { fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '9px 16px', borderRadius: 8, textDecoration: 'none', cursor: 'pointer', flexShrink: 0 },
  filters: { marginBottom: 14 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', minWidth: 160 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', cursor: 'pointer', gap: 12 },
  cardLeft: { display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 },
  talkIcon: { fontSize: 22, flexShrink: 0, marginTop: 1 },
  talkTitle: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4 },
  talkMeta: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  projectTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600 },
  givenBy: { color: '#6b7280' },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  signoffBadge: { fontSize: 12, fontWeight: 700, color: '#065f46', background: '#d1fae5', padding: '3px 10px', borderRadius: 10, minWidth: 24, textAlign: 'center' },
  chevron: { fontSize: 10, color: '#6b7280' },
  cardBody: { padding: '0 16px 16px', borderTop: '1px solid #f3f4f6' },
  content: { fontSize: 14, color: '#374151', lineHeight: 1.7, margin: '12px 0 16px', whiteSpace: 'pre-wrap' },
  signoffSection: { background: '#f9fafb', borderRadius: 8, padding: 12, marginBottom: 12 },
  signoffHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 10 },
  signoffTitle: { fontWeight: 700, fontSize: 13, color: '#374151' },
  signBtn: { background: '#059669', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  signedNote: { fontSize: 12, color: '#059669', fontWeight: 600 },
  signoffList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  signoffChip: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 20, padding: '4px 10px', fontSize: 12, color: '#374151', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
  signoffTime: { color: '#6b7280', fontWeight: 400 },
  cardActions: { display: 'flex', gap: 8 },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6, marginLeft: 6, verticalAlign: 'middle' },
  // Form
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  formTitleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  libraryBtn: { fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '6px 14px', borderRadius: 7, cursor: 'pointer' },
  libraryGrid: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '12px 0', borderBottom: '1px solid #f3f4f6' },
  libraryTopic: { fontSize: 12, fontWeight: 600, color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', padding: '6px 12px', borderRadius: 20, cursor: 'pointer', transition: 'background 0.1s' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  charCount: { fontSize: 11, color: '#6b7280' },
  input: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: '100%' },
  textarea: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, width: '100%' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '10px 20px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { color: '#6b7280', fontSize: 15 },
  hint: { color: '#6b7280', fontSize: 14 },
  optional: { fontSize: 11, fontWeight: 400, color: '#6b7280' },
  // Attachments
  attachmentsSection: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', marginBottom: 12 },
  attachmentsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10 },
  attachmentsTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280' },
  attachBtn: { fontSize: 12, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' },
  attachmentList: { display: 'flex', flexDirection: 'column', gap: 6 },
  attachmentRow: { display: 'flex', alignItems: 'center', gap: 8 },
  attachIcon: { fontSize: 15, flexShrink: 0 },
  attachName: { flex: 1, fontSize: 13, color: 'var(--ops-page-accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  attachSize: { fontSize: 11, color: '#6b7280', flexShrink: 0 },
  attachDeleteBtn: { background: 'none', border: 'none', color: '#d1d5db', fontSize: 12, cursor: 'pointer', padding: '0 2px', flexShrink: 0 },
  attachCancelBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 11, cursor: 'pointer', padding: '0 2px', flexShrink: 0 },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  // Quiz — form
  quizSection: { borderTop: '1px solid #f3f4f6', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  quizSectionHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  quizSectionTitle: { fontSize: 13, fontWeight: 700, color: '#374151' },
  quizSectionSub: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  addQuestionBtn: { fontSize: 12, fontWeight: 600, color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '6px 12px', borderRadius: 7, cursor: 'pointer', flexShrink: 0 },
  questionCard: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  questionHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  questionNum: { fontSize: 12, fontWeight: 700, color: '#6b7280', flexShrink: 0 },
  removeQuestionBtn: { fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 },
  optionsList: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20 },
  optionRow: { display: 'flex', alignItems: 'center', gap: 8 },
  removeOptionBtn: { fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 },
  addOptionBtn: { fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', textAlign: 'left', textDecoration: 'underline' },
  thresholdRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  // Quiz — admin card preview
  quizBadge: { background: '#fef3c7', color: '#92400e', padding: '1px 7px', borderRadius: 10, fontWeight: 600, fontSize: 11 },
  adminQuizPreview: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', marginBottom: 12 },
  quizPreviewTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 },
  adminQuestion: { marginBottom: 8 },
  adminQuestionText: { fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 },
  adminOption: { fontSize: 12, color: '#6b7280', paddingLeft: 12, lineHeight: 1.6 },
  adminOptionCorrect: { color: '#059669', fontWeight: 600 },
  // Quiz — worker card
  quizBox: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
  quizTitle: { fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 10 },
  quizQuestion: { marginBottom: 10 },
  quizQuestionText: { fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 },
  quizOption: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' },
  quizOptionText: { fontSize: 13, color: '#374151' },
  quizFail: { fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', marginTop: 8 },
  quizPass: { fontSize: 13, color: '#065f46', background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 6, padding: '8px 12px', marginBottom: 10 },
  quizScore: { fontSize: 11, color: '#6b7280', background: '#f3f4f6', borderRadius: 8, padding: '1px 6px', fontWeight: 500 },
};
