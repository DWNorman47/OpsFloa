import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  AppCapture,
  EndCard,
  FootageSlot,
  Headline,
  Scene,
} from './components';

function Caption({ children }) {
  return <div className="caption"><span>{children}</span></div>;
}

export function FieldToPayroll() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={100} className="hook-scene">{frame => <Headline frame={frame} eyebrow="FIELD TO PAYROLL" title={<>The job moved.<br/><em>Did the paperwork?</em></>} body="Put every hour, approval, and payroll decision on the same path." />}</Scene>
      <Scene from={90} duration={65}>{frame => <FootageSlot frame={frame} duration={65} number={1} title="The workday starts" direction="Wide jobsite arrival. One worker checks a phone, then continues toward the crew." />}</Scene>
      <Scene from={145} duration={145} className="capture-scene">{frame => <><AppCapture frame={frame} duration={145} src="captures/timeclock.png" focus={[50,45]} cursor={{from:[760,420],to:[960,557],clickAt:108}}/><Caption>Clock in to the right project.</Caption></>}</Scene>
      <Scene from={280} duration={155} className="capture-scene">{frame => <><AppCapture frame={frame} duration={155} src="captures/workforce-live.png" focus={[51,55]} cursor={{from:[860,385],to:[940,385],clickAt:122}}/><Caption>See who is working and where.</Caption></>}</Scene>
      <Scene from={425} duration={145} className="capture-scene">{frame => <><AppCapture frame={frame} duration={145} src="captures/workforce-approvals.png" focus={[54,57]} cursor={{from:[1020,610],to:[1160,553],clickAt:108}}/><Caption>Review the exceptions first.</Caption></>}</Scene>
      <Scene from={560} duration={165} className="capture-scene">{frame => <><AppCapture frame={frame} duration={165} src="captures/workforce-payroll.png" focus={[50,58]} cursor={{from:[720,730],to:[875,729],clickAt:125}}/><Caption>Run payroll with the rules resolved.</Caption></>}</Scene>
      <Scene from={715} duration={185}>{frame => <EndCard frame={frame} line="From field to payroll. One flow." subline="Time, oversight, approvals, and pay built for the way contractors work." />}</Scene>
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
