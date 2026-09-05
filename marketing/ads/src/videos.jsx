import React from 'react';
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from 'remotion';
import {
  AppCapture,
  EndCard,
  FootageSlot,
  GuidedCapture,
  Headline,
  Scene,
} from './components';

function Caption({ children }) {
  return <div className="caption"><span>{children}</span></div>;
}

const fieldPayrollStates = [
  { at: 0, src: 'captures/field-payroll/clock-start.png' },
  { at: 24, src: 'captures/field-payroll/clock-projects.png' },
  { at: 48, src: 'captures/field-payroll/clock-selected.png' },
  { at: 82, src: 'captures/field-payroll/clock-confirmed.png' },
  { at: 110, src: 'captures/field-payroll/live.png' },
  { at: 158, src: 'captures/field-payroll/approvals-top.png' },
  { at: 186, src: 'captures/field-payroll/approvals-scrolled.png', transition: 'scroll', transitionFrames: 14 },
  { at: 224, src: 'captures/field-payroll/details.png' },
  { at: 262, src: 'captures/field-payroll/location.png' },
  { at: 335, src: 'captures/field-payroll/location-closed.png' },
  { at: 365, src: 'captures/field-payroll/split.png' },
  { at: 420, src: 'captures/field-payroll/split-time-typing.png' },
  { at: 430, src: 'captures/field-payroll/split-time.png' },
  { at: 455, src: 'captures/field-payroll/split-project-open.png' },
  { at: 470, src: 'captures/field-payroll/split-project.png' },
  { at: 515, src: 'captures/field-payroll/split-saved.png' },
  { at: 583, src: 'captures/field-payroll/one-approved.png' },
  { at: 617, src: 'captures/field-payroll/both-approved.png' },
];

const fieldPayrollMoves = [
  { start: 4, end: 17, from: [1970, 490], to: [960, 490], clickAt: 21 },
  { start: 28, end: 39, from: [960, 490], to: [820, 555], clickAt: 44 },
  { start: 54, end: 71, from: [820, 555], to: [960, 628], clickAt: 78 },
  { start: 135, end: 151, from: [1970, 385], to: [690, 385], clickAt: 155 },
  { start: 164, end: 177, from: [690, 385], to: [1875, 700] },
  { start: 195, end: 211, from: [1875, 700], to: [960, 658], clickAt: 219 },
  { start: 230, end: 248, from: [960, 658], to: [650, 650], clickAt: 258 },
  { start: 270, end: 278, from: [650, 650], to: [900, 820] },
  { start: 315, end: 323, from: [900, 820], to: [640, 650], clickAt: 330 },
  { start: 340, end: 356, from: [640, 650], to: [707, 696], clickAt: 362 },
  { start: 374, end: 394, from: [707, 696], to: [1118, 658], clickAt: 400 },
  { start: 436, end: 447, from: [1118, 658], to: [1255, 902], clickAt: 451 },
  { start: 458, end: 463, from: [1255, 902], to: [1255, 725], clickAt: 466 },
  { start: 479, end: 498, from: [1255, 725], to: [980, 1012], clickAt: 510 },
  { start: 527, end: 543, from: [980, 1012], to: [830, 626] },
  { start: 565, end: 575, from: [830, 626], to: [1293, 584], clickAt: 579 },
  { start: 593, end: 607, from: [1293, 584], to: [1293, 584], clickAt: 613 },
];

const payrollRunStates = [
  { at: 0, src: 'captures/field-payroll/payroll-ready.png' },
  { at: 68, src: 'captures/field-payroll/payroll-results.png', transition: 'scroll', transitionFrames: 12 },
];

const payrollRunMoves = [
  { start: 5, end: 30, from: [1970, 728], to: [1198, 728], clickAt: 52 },
];

const reportsStates = [
  { at: 0, src: 'captures/field-payroll/reports-collapsed.png' },
  { at: 52, src: 'captures/field-payroll/reports-team-open.png' },
  { at: 105, src: 'captures/field-payroll/reports-worker-selected.png' },
  { at: 155, src: 'captures/field-payroll/reports-last-week.png' },
  { at: 210, src: 'captures/field-payroll/reports-generated.png' },
  { at: 270, src: 'captures/field-payroll/reports-details.png' },
  { at: 335, src: 'captures/field-payroll/reports-overtime-date.png' },
  { at: 410, src: 'captures/field-payroll/reports-preview-ready.png', transition: 'scroll', transitionFrames: 14 },
  { at: 470, src: 'captures/field-payroll/reports-bill-preview.png' },
];

const reportsMoves = [
  { start: 8, end: 38, from: [1970, 326], to: [960, 326], clickAt: 47 },
  { start: 62, end: 88, from: [960, 326], to: [640, 358], clickAt: 100 },
  { start: 112, end: 138, from: [640, 358], to: [889, 364], clickAt: 150 },
  { start: 162, end: 190, from: [889, 364], to: [916, 314], clickAt: 205 },
  { start: 222, end: 248, from: [916, 314], to: [580, 418], clickAt: 265 },
  { start: 282, end: 315, from: [580, 418], to: [600, 710], clickAt: 330 },
  { start: 348, end: 388, from: [600, 710], to: [760, 895] },
  { start: 424, end: 452, from: [760, 895], to: [600, 700], clickAt: 465 },
];

const fieldPayrollVoice = [
  { from: 5, src: 'audio/field-payroll/01-hook.wav' },
  { from: 95, src: 'audio/field-payroll/02-clock-in.wav' },
  { from: 255, src: 'audio/field-payroll/03-oversight.wav' },
  { from: 460, src: 'audio/field-payroll/04-approval.wav' },
  { from: 735, src: 'audio/field-payroll/05-reports-intro.wav' },
  { from: 875, src: 'audio/field-payroll/06-report-range.wav' },
  { from: 1050, src: 'audio/field-payroll/07-overtime-preview.wav' },
  { from: 1280, src: 'audio/field-payroll/08-payroll-addon.wav' },
  { from: 1470, src: 'audio/field-payroll/09-close.wav' },
];

function FieldPayrollAudio() {
  return (
    <>
      <Audio
        src={staticFile('audio/field-payroll/music.wav')}
        volume={frame => interpolate(frame, [0, 24, 1565, 1639], [0, 0.11, 0.11, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })}
      />
      {fieldPayrollVoice.map(clip => (
        <Sequence key={clip.src} from={clip.from}>
          <Audio src={staticFile(clip.src)} volume={0.96} />
        </Sequence>
      ))}
    </>
  );
}

export function FieldToPayroll() {
  return (
    <AbsoluteFill className="video-root">
      <FieldPayrollAudio />
      <Scene from={0} duration={100} className="hook-scene">{frame => <Headline frame={frame} eyebrow="FIELD TO PAYROLL" title={<>The job moved.<br/><em>Did the paperwork?</em></>} body="Put every hour, approval, and payroll decision on the same path." />}</Scene>
      <Scene from={90} duration={640} className="capture-scene">{frame => <GuidedCapture frame={frame} states={fieldPayrollStates} moves={fieldPayrollMoves} cursorWindows={[[4, 90], [135, 625]]} />}</Scene>
      <Scene from={720} duration={560} className="capture-scene">{frame => <GuidedCapture frame={frame} states={reportsStates} moves={reportsMoves} cursorWindows={[[8, 470]]} />}</Scene>
      <Scene from={1270} duration={150} className="capture-scene">{frame => <><GuidedCapture frame={frame} states={payrollRunStates} moves={payrollRunMoves} cursorWindows={[[5, 64]]}/><Caption>With the Payroll add-on, run payroll from the scheduled pay period.</Caption></>}</Scene>
      <Scene from={1410} duration={230}>{frame => <EndCard frame={frame} line="From field to payroll. One flow." subline="Time, oversight, approvals, and pay built for the way contractors work." />}</Scene>
    </AbsoluteFill>
  );
}

export function PlansToProject() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={105} className="hook-scene plans-hook">{frame => <Headline frame={frame} eyebrow="PLAN ROOM + TAKEOFF" title={<>Stop rebuilding the job<br/><em>after you win it.</em></>} body="Start with the plan. Carry the work forward." />}</Scene>
      <Scene from={95} duration={325} className="capture-scene">{frame => <><AppCapture frame={frame} duration={325} src="captures/plan-room.png" focus={[56,48]} zoom={1.085} cursor={{from:[1420,22],to:[1040,520],clickAt:270}}/><Caption>Trace it. Adjust the points. Price the takeoff.</Caption></>}</Scene>
      <Scene from={410} duration={185} className="capture-scene">{frame => <><AppCapture frame={frame} duration={185} src="captures/estimates.png" focus={[51,31]} zoom={1.075} cursor={{from:[650,305],to:[1180,350],clickAt:140}}/><Caption>The takeoff becomes the estimate.</Caption></>}</Scene>
      <Scene from={585} duration={145} className="capture-scene">{frame => <><AppCapture frame={frame} duration={145} src="captures/projects.png" focus={[51,48]} cursor={{from:[1110,280],to:[1260,205],clickAt:105}}/><Caption>Accepted work becomes an active project.</Caption></>}</Scene>
      <Scene from={720} duration={180}>{frame => <EndCard frame={frame} line="From plan to project. Keep the thread." subline="Measure, estimate, win, and run the work in OpsFloa." />}</Scene>
    </AbsoluteFill>
  );
}

export function ProtectTheMargin() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={100} className="hook-scene margin-hook">{frame => <Headline frame={frame} eyebrow="PROTECT THE MARGIN" title={<>Margin doesn’t disappear<br/><em>all at once.</em></>} body="It leaks through disconnected labor, cost, changes, and billing." />}</Scene>
      <Scene from={90} duration={65}>{frame => <FootageSlot frame={frame} duration={65} number={2} title="Progress in one glance" direction="Slow lateral shot across an active project. A superintendent crosses frame with a tablet." />}</Scene>
      <Scene from={145} duration={190} className="capture-scene">{frame => <><AppCapture frame={frame} duration={190} src="captures/projects.png" focus={[50,50]} zoom={1.07} cursor={{from:[940,620],to:[1240,455],clickAt:145}}/><Caption>Know every project’s labor and budget.</Caption></>}</Scene>
      <Scene from={325} duration={205} className="capture-scene">{frame => <><AppCapture frame={frame} duration={205} src="captures/performance.png" focus={[52,48]} zoom={1.07} cursor={{from:[540,170],to:[1040,475],clickAt:160}}/><Caption>Spot pressure while there’s time to act.</Caption></>}</Scene>
      <Scene from={520} duration={120} className="capture-scene">{frame => <><AppCapture frame={frame} duration={120} src="captures/change-orders.png" focus={[56,27]} zoom={1.09} cursor={{from:[820,270],to:[1150,270],clickAt:88}}/><Caption>Keep changes tied to the job.</Caption></>}</Scene>
      <Scene from={630} duration={100} className="close-scene">{frame => <Headline frame={frame} align="center" eyebrow="ONE LIVE PICTURE" title="Labor. Cost. Billing. Cash." body="Every update changes the same project story."/>}</Scene>
      <Scene from={720} duration={180}>{frame => <EndCard frame={frame} line="See the job before it surprises you." subline="Protect every project’s margin with OpsFloa." />}</Scene>
    </AbsoluteFill>
  );
}
