import React from 'react';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  HardHat,
  MapPin,
  MousePointer2,
  PackageCheck,
  ReceiptText,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

export const colors = {
  ink: '#0b1220',
  navy: '#111827',
  blue: '#1a56db',
  blueDark: '#153f9f',
  teal: '#0f766e',
  green: '#84cc16',
  pale: '#f4f7fb',
  line: '#dbe3ef',
  muted: '#64748b',
  white: '#ffffff',
  amber: '#f59e0b',
  red: '#dc2626',
};

export function Scene({ from, duration, children, className = '' }) {
  const frame = useCurrentFrame();
  if (frame < from || frame >= from + duration) return null;
  const local = frame - from;
  const opacity = interpolate(local, [0, 10, duration - 10, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <div className={`scene ${className}`} style={{ opacity }}>{children(local)}</div>;
}

export function Rise({ frame, delay = 0, children, distance = 38, className = '' }) {
  const { fps } = useVideoConfig();
  const progress = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 18, stiffness: 120 } });
  return (
    <div className={className} style={{ opacity: progress, transform: `translateY(${(1 - progress) * distance}px)` }}>
      {children}
    </div>
  );
}

export function Brand({ light = false }) {
  return (
    <div className={`brand ${light ? 'brand-light' : ''}`}>
      <div className="brand-mark"><ChevronRight size={31} strokeWidth={3.2} /></div>
      <span>OPSFLOA</span>
    </div>
  );
}

export function Headline({ frame, eyebrow, title, body, align = 'left' }) {
  return (
    <div className={`headline headline-${align}`}>
      <Rise frame={frame}><div className="eyebrow">{eyebrow}</div></Rise>
      <Rise frame={frame} delay={5}><h1>{title}</h1></Rise>
      {body && <Rise frame={frame} delay={10}><p>{body}</p></Rise>}
    </div>
  );
}

export function FootageSlot({ frame, number, title, direction, duration }) {
  const sweep = interpolate(frame, [0, Math.max(1, duration)], [-20, 120], { extrapolateRight: 'clamp' });
  return (
    <div className="footage-slot">
      <div className="footage-grid" />
      <div className="footage-sweep" style={{ left: `${sweep}%` }} />
      <Brand light />
      <div className="footage-label">LIVE-ACTION REPLACEMENT {String(number).padStart(2, '0')}</div>
      <div className="footage-copy">
        <HardHat size={54} />
        <h2>{title}</h2>
        <p>{direction}</p>
      </div>
      <div className="footage-meta">16:9 master • center-safe for vertical crop • no dialogue</div>
    </div>
  );
}

export function AppCapture({ frame, duration, src, focus = [50, 50], zoom = 1.055, cursor }) {
  const scale = interpolate(frame, [0, duration], [1, zoom], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cursorProgress = cursor
    ? interpolate(frame, [cursor.start || 8, cursor.end || duration - 18], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;
  const cursorX = cursor ? interpolate(cursorProgress, [0, 1], [cursor.from[0], cursor.to[0]]) : 0;
  const cursorY = cursor ? interpolate(cursorProgress, [0, 1], [cursor.from[1], cursor.to[1]]) : 0;
  const clickFrame = cursor?.clickAt ?? duration - 24;
  const clickPulse = cursor
    ? interpolate(Math.abs(frame - clickFrame), [0, 12], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;

  return (
    <div className="app-capture">
      <Img
        src={staticFile(src)}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${focus[0]}% ${focus[1]}%`,
        }}
      />
      {cursor && (
        <div className="capture-cursor" style={{ left: cursorX, top: cursorY }}>
          <i style={{ opacity: clickPulse, transform: `scale(${1 + clickPulse * 1.2})` }} />
          <MousePointer2 size={34} fill="#ffffff" stroke="#0b1220" strokeWidth={2.2} />
        </div>
      )}
    </div>
  );
}

export function BrowserShell({ title, children, active = 'Overview', accent = colors.blue }) {
  return (
    <div className="browser-shell">
      <div className="browser-top">
        <div className="traffic"><i /><i /><i /></div>
        <div className="browser-title">{title}</div>
        <div className="browser-user">DN</div>
      </div>
      <div className="app-shell">
        <aside>
          <Brand />
          {['Overview', 'Time Clock', 'Field', 'Work', 'Reports'].map(item => (
            <div key={item} className={`nav-item ${item === active ? 'active' : ''}`} style={item === active ? { '--nav-accent': accent } : {}}>
              <span className="nav-dot" />{item}
            </div>
          ))}
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}

export function PhoneClock({ frame }) {
  const confirm = frame > 55;
  return (
    <div className="phone">
      <div className="phone-speaker" />
      <div className="phone-content">
        <Brand />
        <div className="phone-kicker">TIME CLOCK</div>
        <h3>{confirm ? 'You’re clocked in' : 'Ready for the day?'}</h3>
        <div className={`clock-orb ${confirm ? 'confirmed' : ''}`}>
          {confirm ? <Check size={56} strokeWidth={3} /> : <Clock3 size={56} />}
        </div>
        <div className="project-choice"><MapPin size={20} /> Downtown Medical Office</div>
        <div className="clock-button">{confirm ? '07:02 AM' : 'Clock In'}</div>
      </div>
    </div>
  );
}

export function ChecklistCard({ frame }) {
  const rows = ['PPE inspected', 'Crew briefing complete', 'Work area secured'];
  return (
    <div className="checklist-card">
      <div className="panel-title"><ShieldCheck size={26} /> Daily safety checklist</div>
      <div className="panel-sub">Downtown Medical Office • Today</div>
      {rows.map((row, index) => {
        const checked = frame > 22 + index * 18;
        return <div className="check-row" key={row}><span className={checked ? 'checked' : ''}>{checked && <Check size={18} />}</span>{row}</div>;
      })}
      <div className="submit-row"><button>Complete checklist</button></div>
    </div>
  );
}

export function LiveWorkforce({ frame }) {
  const people = [
    ['Maya Chen', 'Downtown Medical', '2h 14m'],
    ['Luis Rivera', 'Warehouse Expansion', '1h 52m'],
    ['Jordan Brooks', 'Northside Renovation', '1h 37m'],
  ];
  return (
    <BrowserShell title="Workforce • Live" active="Time Clock" accent={colors.teal}>
      <div className="page-heading"><div><span>WORKFORCE</span><h2>Live operations</h2></div><div className="live-pill"><i /> Live</div></div>
      <div className="kpi-grid">
        <Kpi icon={Users} value="12" label="Working now" />
        <Kpi icon={Clock3} value="41.8h" label="Today’s hours" />
        <Kpi icon={MapPin} value="4" label="Active projects" />
      </div>
      <div className="live-layout">
        <div className="worker-list">
          {people.map((person, index) => <div className="worker-row" key={person[0]} style={{ opacity: frame > index * 8 ? 1 : 0 }}><div className="avatar">{person[0].split(' ').map(v => v[0]).join('')}</div><div><strong>{person[0]}</strong><span>{person[1]}</span></div><b>{person[2]}</b></div>)}
        </div>
        <div className="map-panel"><div className="map-road road-a" /><div className="map-road road-b" /><div className="map-road road-c" />{[[28,35],[62,28],[55,67]].map((pos, i) => <MapPin key={i} className="map-pin" size={38} fill={colors.teal} style={{ left: `${pos[0]}%`, top: `${pos[1]}%`, transform: `scale(${frame > i * 10 ? 1 : 0})` }} />)}</div>
      </div>
    </BrowserShell>
  );
}

export function PayrollFlow({ frame }) {
  const approved = Math.min(24, Math.max(0, Math.floor(frame / 3)));
  return (
    <BrowserShell title="Workforce • Payroll" active="Time Clock" accent={colors.blue}>
      <div className="page-heading"><div><span>PAYROLL</span><h2>Review and run</h2></div><button className="primary-button">Run payroll</button></div>
      <div className="payroll-grid">
        <div className="pay-card"><span>PAY PERIOD</span><strong>Aug 17–30</strong><small>24 team members</small></div>
        <div className="pay-card"><span>APPROVED</span><strong>{approved} / 24</strong><div className="mini-progress"><i style={{ width: `${approved / 24 * 100}%` }} /></div></div>
        <div className="pay-card green"><span>ESTIMATED GROSS</span><strong>$38,420</strong><small>Rules applied automatically</small></div>
      </div>
      <div className="pay-table"><div className="table-head"><span>Team member</span><span>Regular</span><span>Overtime</span><span>Prevailing</span><span>Gross</span></div>{[['Maya Chen','40.0','3.5','0.0','$2,145'],['Luis Rivera','32.0','0.0','8.0','$2,360'],['Jordan Brooks','40.0','5.0','0.0','$2,290']].map((r,i)=><div className="table-row" key={r[0]} style={{ opacity: frame > 12 + i * 7 ? 1 : 0 }}>{r.map(c=><span key={c}>{c}</span>)}</div>)}</div>
    </BrowserShell>
  );
}

export function Kpi({ icon: Icon, value, label, tone }) {
  return <div className={`kpi ${tone || ''}`}><div><Icon size={25} /></div><strong>{value}</strong><span>{label}</span></div>;
}

export function Blueprint({ frame }) {
  const pointCount = Math.min(6, Math.max(0, Math.floor(frame / 10)));
  const path = 'M 145 620 L 340 305 L 620 242 L 812 410 L 705 672 L 390 742 Z';
  const points = [[145,620],[340,305],[620,242],[812,410],[705,672],[390,742]];
  return (
    <div className="blueprint">
      <div className="blueprint-toolbar"><Brand light /><span>PLAN ROOM</span><b>Site Grading • C-3.1</b><button>Takeoff</button></div>
      <svg viewBox="0 0 960 810" aria-label="Animated excavation takeoff">
        <g className="plan-lines"><path d="M40 170 H900 M60 260 H860 M80 500 H920 M170 80 V760 M490 60 V780 M760 110 V760"/><path d="M160 160 C330 60 610 100 830 180 C720 310 660 355 840 500 C650 620 400 650 100 560"/><rect x="250" y="360" width="420" height="250"/><path d="M250 430 H670 M350 360 V610 M560 360 V610"/></g>
        <path className="takeoff-fill" d={path} style={{ opacity: interpolate(pointCount, [2, 6], [0, .18], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }} />
        <path className="takeoff-path" d={path} pathLength="1" style={{ strokeDashoffset: 1 - pointCount / 6 }} />
        {points.slice(0, pointCount).map((p,i)=><circle className="takeoff-point" key={i} cx={p[0]} cy={p[1]} r={i === pointCount - 1 ? 13 : 9} />)}
      </svg>
      <div className="measure-panel"><span>AREA TAKEOFF</span><strong>{pointCount < 6 ? 'Tracing…' : '12,480 SF'}</strong><small>Site excavation • 1.50 FT depth</small><div><b>693 CY</b><em>$18.50 / CY</em></div><button><PackageCheck size={20} /> Add to estimate</button></div>
    </div>
  );
}

export function EstimateFlow({ frame }) {
  const accepted = frame > 70;
  return (
    <BrowserShell title="Work • Estimates" active="Work" accent={colors.blue}>
      <div className="page-heading"><div><span>ESTIMATE #1048</span><h2>Northside Sitework</h2></div><div className={`status-pill ${accepted ? 'accepted' : ''}`}>{accepted ? <CheckCircle2 size={19}/> : <Clock3 size={19}/>} {accepted ? 'Accepted' : 'Ready to send'}</div></div>
      <div className="estimate-layout">
        <div className="estimate-lines"><div className="table-head estimate"><span>Scope</span><span>Qty</span><span>Rate</span><span>Total</span></div>{[['Site excavation','693 CY','$18.50','$12,820.50'],['Aggregate base','210 TN','$42.00','$8,820.00'],['Mobilization','1 LS','$2,400','$2,400.00']].map((r,i)=><div className="table-row estimate" key={r[0]} style={{ transform:`translateX(${frame > i*8 ? 0 : 40}px)`,opacity:frame > i*8?1:0 }}>{r.map(c=><span key={c}>{c}</span>)}</div>)}</div>
        <div className="estimate-total"><span>ESTIMATE TOTAL</span><strong>$24,040.50</strong><small>Built from Plan Room takeoff</small><button>{accepted ? 'Convert to project' : 'Send to client'}</button></div>
      </div>
      {accepted && <div className="accept-toast"><CheckCircle2 size={25}/> Client accepted • Ready to become a project</div>}
    </BrowserShell>
  );
}

export function MarginDashboard({ frame }) {
  const reveal = p => interpolate(frame, [5, 55], [0, p], { extrapolateLeft:'clamp', extrapolateRight:'clamp' });
  return (
    <BrowserShell title="Reports • Project Performance" active="Reports" accent={colors.green}>
      <div className="page-heading"><div><span>PROJECT PERFORMANCE</span><h2>Northside Sitework</h2></div><div className="healthy"><TrendingUp size={20}/> Margin healthy</div></div>
      <div className="margin-kpis"><Kpi icon={CircleDollarSign} value="$186,400" label="Contract value"/><Kpi icon={ReceiptText} value="$121,770" label="Cost to date"/><Kpi icon={TrendingUp} value="34.7%" label="Projected margin" tone="success"/></div>
      <div className="cost-panel"><div className="panel-title">Cost against budget</div>{[['Labor',68,colors.blue],['Materials',51,colors.teal],['Equipment',74,colors.amber],['Subcontractors',39,colors.green]].map((r,i)=><div className="cost-row" key={r[0]}><span>{r[0]}</span><div><i style={{width:`${reveal(r[1])}%`,background:r[2]}}/></div><b>{r[1]}%</b></div>)}</div>
      <div className="activity-panel"><div className="panel-title">Connected activity</div>{[[Users,'Labor posted','$8,420'],[PackageCheck,'Equipment logged','$2,180'],[FileCheck2,'Change order accepted','+$12,600']].map(([Icon,label,value],i)=><div className="activity-row" key={label} style={{opacity:frame > 10+i*12?1:0}}><Icon size={22}/><span>{label}</span><strong>{value}</strong></div>)}</div>
    </BrowserShell>
  );
}

export function MoneyFlow({ frame }) {
  const steps = [
    [FileCheck2, 'Change order approved', '+$12,600'],
    [ReceiptText, 'Progress invoice sent', '$58,900'],
    [CheckCircle2, 'Payment recorded', '$58,900'],
  ];
  return <div className="money-flow"><Brand light/><h2>Nothing falls through the cracks.</h2><div className="money-steps">{steps.map(([Icon,label,value],i)=><React.Fragment key={label}><div className="money-step" style={{opacity:frame > i*18?1:.15,transform:`scale(${frame > i*18?1:.92})`}}><Icon size={32}/><span>{label}</span><strong>{value}</strong></div>{i<steps.length-1&&<ChevronRight size={38} className="flow-arrow"/>}</React.Fragment>)}</div></div>;
}

export function EndCard({ frame, line, subline }) {
  return (
    <div className="end-card">
      <div className="end-grid" />
      <Rise frame={frame}><Brand light /></Rise>
      <Rise frame={frame} delay={6}><h2>{line}</h2></Rise>
      <Rise frame={frame} delay={11}><p>{subline}</p></Rise>
      <Rise frame={frame} delay={16}><div className="cta">See your operation clearly <ChevronRight size={25}/></div></Rise>
      <div className="url">opsfloa.com</div>
    </div>
  );
}
