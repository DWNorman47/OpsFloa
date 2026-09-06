import React from 'react';
import { Composition } from 'remotion';
import { FieldToPayroll, PlansToProject, ProtectTheMargin } from './videos';

const video = {
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 900,
};

export function AdsRoot() {
  return (
    <>
      <Composition id="field-to-payroll" component={FieldToPayroll} {...video} durationInFrames={1740} />
      <Composition id="plans-to-project" component={PlansToProject} {...video} />
      <Composition id="protect-the-margin" component={ProtectTheMargin} {...video} />
    </>
  );
}
