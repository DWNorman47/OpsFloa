import React from 'react';
import { AbsoluteFill } from 'remotion';
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
  { at: 18, src: 'captures/field-payroll/clock-projects.png' },
  { at: 34, src: 'captures/field-payroll/clock-selected.png' },
  { at: 64, src: 'captures/field-payroll/clock-confirmed.png' },
  { at: 90, src: 'captures/field-payroll/live.png' },
  { at: 128, src: 'captures/field-payroll/approvals-top.png' },
  { at: 148, src: 'captures/field-payroll/approvals-scrolled.png', transition: 'scroll', transitionFrames: 10 },
  { at: 176, src: 'captures/field-payroll/details.png' },
  { at: 205, src: 'captures/field-payroll/location.png' },
  { at: 260, src: 'captures/field-payroll/location-closed.png' },
  { at: 282, src: 'captures/field-payroll/split.png' },
  { at: 318, src: 'captures/field-payroll/split-time.png' },
  { at: 347, src: 'captures/field-payroll/split-project.png' },
  { at: 382, src: 'captures/field-payroll/split-saved.png' },
  { at: 433, src: 'captures/field-payroll/one-approved.png' },
  { at: 458, src: 'captures/field-payroll/both-approved.png' },
];

const fieldPayrollMoves = [
  { start: 3, end: 12, from: [1970, 490], to: [960, 490], clickAt: 16 },
  { start: 20, end: 28, from: [960, 490], to: [820, 555], clickAt: 31 },
  { start: 38, end: 52, from: [820, 555], to: [960, 628], clickAt: 60 },
  { start: 110, end: 121, from: [1970, 385], to: [690, 385], clickAt: 125 },
  { start: 132, end: 141, from: [690, 385], to: [1875, 700] },
  { start: 154, end: 165, from: [1875, 700], to: [960, 658], clickAt: 171 },
  { start: 180, end: 192, from: [960, 658], to: [650, 650], clickAt: 201 },
  { start: 210, end: 216, from: [650, 650], to: [900, 820] },
  { start: 249, end: 253, from: [900, 820], to: [640, 650], clickAt: 257 },
  { start: 263, end: 272, from: [640, 650], to: [707, 696], clickAt: 278 },
  { start: 287, end: 298, from: [707, 696], to: [1118, 658], clickAt: 302 },
  { start: 322, end: 333, from: [1118, 658], to: [1255, 772], clickAt: 338 },
  { start: 352, end: 364, from: [1255, 772], to: [980, 882], clickAt: 376 },
  { start: 388, end: 400, from: [980, 882], to: [830, 626] },
  { start: 416, end: 425, from: [830, 626], to: [1293, 584], clickAt: 429 },
  { start: 440, end: 447, from: [1293, 584], to: [1293, 584], clickAt: 454 },
];

export function FieldToPayroll() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={100} className="hook-scene">{frame => <Headline frame={frame} eyebrow="FIELD TO PAYROLL" title={<>The job moved.<br/><em>Did the paperwork?</em></>} body="Put every hour, approval, and payroll decision on the same path." />}</Scene>
      <Scene from={90} duration={65}>{frame => <FootageSlot frame={frame} duration={65} number={1} title="The workday starts" direction="Wide jobsite arrival. One worker checks a phone, then continues toward the crew." />}</Scene>
      <Scene from={145} duration={475} className="capture-scene">{frame => <GuidedCapture frame={frame} states={fieldPayrollStates} moves={fieldPayrollMoves} cursorWindows={[[3, 70], [110, 462]]} />}</Scene>
      <Scene from={610} duration={150} className="capture-scene">{frame => <><AppCapture frame={frame} duration={150} src="captures/workforce-payroll.png" focus={[50,58]} cursor={{from:[720,730],to:[875,729],clickAt:112}}/><Caption>Run payroll with the rules resolved.</Caption></>}</Scene>
      <Scene from={750} duration={150}>{frame => <EndCard frame={frame} line="From field to payroll. One flow." subline="Time, oversight, approvals, and pay built for the way contractors work." />}</Scene>
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
