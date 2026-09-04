import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  Blueprint,
  ChecklistCard,
  EndCard,
  EstimateFlow,
  FootageSlot,
  Headline,
  LiveWorkforce,
  MarginDashboard,
  MoneyFlow,
  PayrollFlow,
  PhoneClock,
  Rise,
  Scene,
} from './components';

function Caption({ children }) {
  return <div className="caption"><span>{children}</span></div>;
}

export function FieldToPayroll() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={105} className="hook-scene">{frame => <Headline frame={frame} eyebrow="FIELD TO PAYROLL" title={<>The job moved.<br/><em>Did the paperwork?</em></>} body="Put every hour, checklist, and approval on the same path." />}</Scene>
      <Scene from={95} duration={80}>{frame => <FootageSlot frame={frame} duration={80} number={1} title="The workday starts" direction="Wide jobsite arrival. One worker walks toward camera, checks a phone, then continues toward the crew." />}</Scene>
      <Scene from={165} duration={120} className="product-scene">{frame => <><div className="split-copy"><Headline frame={frame} eyebrow="ONE TAP" title="Clock in to the right job." body="Project, time, and location stay connected." /></div><Rise frame={frame} delay={8} className="phone-wrap"><PhoneClock frame={frame}/></Rise><Caption>Crews start clean.</Caption></>}</Scene>
      <Scene from={275} duration={115} className="checklist-scene">{frame => <><div className="split-copy"><Headline frame={frame} eyebrow="REQUIRED WORKFLOWS" title="The checklist shows up when it matters." body="Safety and project requirements become part of the day." /></div><Rise frame={frame} delay={8} className="checklist-wrap"><ChecklistCard frame={frame}/></Rise><Caption>Requirements happen before the work.</Caption></>}</Scene>
      <Scene from={380} duration={150} className="screen-scene">{frame => <><div className="screen-wrap"><LiveWorkforce frame={frame}/></div><Caption>Operations sees the field in real time.</Caption></>}</Scene>
      <Scene from={520} duration={190} className="screen-scene">{frame => <><div className="screen-wrap"><PayrollFlow frame={frame}/></div><Caption>Approve once. Apply every pay rule.</Caption></>}</Scene>
      <Scene from={700} duration={200}>{frame => <EndCard frame={frame} line="From field to payroll. One flow." subline="Time, safety, approvals, and pay built for the way contractors work." />}</Scene>
    </AbsoluteFill>
  );
}

export function PlansToProject() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={120} className="hook-scene plans-hook">{frame => <Headline frame={frame} eyebrow="PLAN ROOM + TAKEOFF" title={<>Stop rebuilding the job<br/><em>after you win it.</em></>} body="Start with the plan. Carry the work forward." />}</Scene>
      <Scene from={110} duration={290} className="blueprint-scene">{frame => <><div className="blueprint-wrap"><Blueprint frame={frame}/></div><Caption>Trace it. Adjust it. Price it.</Caption></>}</Scene>
      <Scene from={390} duration={250} className="screen-scene">{frame => <><div className="screen-wrap"><EstimateFlow frame={frame}/></div><Caption>The takeoff becomes the estimate.</Caption></>}</Scene>
      <Scene from={630} duration={105} className="handoff-scene">{frame => <><Headline frame={frame} align="center" eyebrow="NO RE-ENTRY" title="Accepted becomes active." body="The winning estimate turns into a working project with its scope intact."/><Rise frame={frame} delay={10} className="handoff-path"><span>PLAN</span><i>→</i><span>TAKEOFF</span><i>→</i><span>ESTIMATE</span><i>→</i><span>PROJECT</span></Rise></>}</Scene>
      <Scene from={725} duration={175}>{frame => <EndCard frame={frame} line="From plan to project. Keep the thread." subline="Measure, estimate, win, and run the work in OpsFloa." />}</Scene>
    </AbsoluteFill>
  );
}

export function ProtectTheMargin() {
  return (
    <AbsoluteFill className="video-root">
      <Scene from={0} duration={115} className="hook-scene margin-hook">{frame => <Headline frame={frame} eyebrow="PROTECT THE MARGIN" title={<>Margin doesn’t disappear<br/><em>all at once.</em></>} body="It leaks through disconnected labor, materials, equipment, and billing." />}</Scene>
      <Scene from={105} duration={70}>{frame => <FootageSlot frame={frame} duration={70} number={2} title="Progress in one glance" direction="Slow lateral shot across an active project. Equipment in motion; superintendent crosses frame with tablet." />}</Scene>
      <Scene from={165} duration={280} className="screen-scene">{frame => <><div className="screen-wrap"><MarginDashboard frame={frame}/></div><Caption>See cost pressure while there’s time to act.</Caption></>}</Scene>
      <Scene from={435} duration={170} className="money-scene">{frame => <MoneyFlow frame={frame}/>}</Scene>
      <Scene from={595} duration={125} className="close-scene">{frame => <Headline frame={frame} align="center" eyebrow="ONE LIVE PICTURE" title="Labor. Cost. Billing. Cash." body="Every update changes the same project story."/>}</Scene>
      <Scene from={710} duration={190}>{frame => <EndCard frame={frame} line="See the job before it surprises you." subline="Protect every project’s margin with OpsFloa." />}</Scene>
    </AbsoluteFill>
  );
}
