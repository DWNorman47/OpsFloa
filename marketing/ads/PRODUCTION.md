# OpsFloa Product-Led Ad Campaign

Three 30-second ads are built as editable Remotion compositions. The campaign uses only two short live-action replacements in total; every other scene is product animation, typography, or branding.

## Campaign structure

| Composition | Promise | Live footage required |
| --- | --- | --- |
| `field-to-payroll` | Put time, safety, oversight, approval, and payroll in one flow. | One 2.5-second jobsite arrival shot |
| `plans-to-project` | Carry measured scope from Plan Room through takeoff, estimate, acceptance, and project creation. | None |
| `protect-the-margin` | Connect labor, materials, equipment, changes, billing, and cash before margin slips. | One 2-second active-project shot |

The footage placeholders are deliberately center-safe so the same source clips can support horizontal, square, and vertical edits. Neither clip needs dialogue or synchronized sound.

## Live-action shot brief

### Replacement 01: The workday starts

- Length: 2.5 seconds usable, capture at least 8 seconds.
- Shot: Wide jobsite arrival. One worker walks toward camera, checks a phone, then continues toward the crew.
- Camera: Locked or very slow push; 4K/30 preferred.
- Framing: Keep the worker and phone inside the center 40% for vertical cropping.
- Wardrobe: Real company PPE with no third-party logos prominently visible.
- Audio: Not needed.

### Replacement 02: Progress in one glance

- Length: 2 seconds usable, capture at least 8 seconds.
- Shot: Slow lateral move across an active project. Equipment moves in the background while a superintendent crosses frame with a tablet.
- Camera: Gimbal or steady handheld; 4K/30 preferred.
- Framing: Keep the superintendent center-safe and leave open space to the left.
- Audio: Not needed.

## Voiceover scripts

### Field to Payroll

The job moved. Did the paperwork? With OpsFloa, crews clock in to the right project and complete required checklists before work begins. Operations sees who is working and where. Time moves into approval, every pay rule is applied, and payroll is ready. From field to payroll, one flow. OpsFloa.

### Plans to Project

Stop rebuilding the job after you win it. Open the plan, set the scale, trace the work, adjust the points, and price the takeoff. Send the estimate for acceptance, then turn the winning scope into a working project. From plan to project, keep the thread with OpsFloa.

### Protect the Margin

Margin does not disappear all at once. It leaks through disconnected labor, materials, equipment, and billing. OpsFloa keeps every cost against the same project picture, while change orders, invoices, and payments keep moving. See the job before it surprises you. Protect the margin with OpsFloa.

## Audio direction

- Music: Confident, restrained industrial rhythm at 105–115 BPM. Avoid cinematic trailer percussion.
- Voice: Calm owner-operator authority; conversational rather than announcer-like.
- Mix: Voice dominant, music about 16 dB below narration, subtle interface taps only.
- End card: Let the music resolve cleanly beneath `opsfloa.com`.

## Working with the compositions

```powershell
cd C:\Users\davno\Projects\OpsFloa\marketing\ads
npm install
npm run studio
npm run render
```

Rendered MP4 files are written to `marketing/ads/renders/` and intentionally excluded from Git. Replace each `FootageSlot` component in `src/videos.jsx` with the final clip once footage is available.

On Windows ARM64, the render script automatically uses installed Google Chrome or Microsoft Edge because Remotion does not distribute an ARM64 headless-shell download. Set `REMOTION_BROWSER_EXECUTABLE` to override that choice. Remotion's native encoder is also x64-only on Windows; point `REMOTION_BINARIES_DIR` at a compatible Remotion compositor bundle when rendering on ARM64.

## Delivery checklist

- Replace the two footage slates.
- Record final voiceover using the scripts above.
- License and add one music track across the campaign.
- Verify all claims against the release being advertised.
- Export 1920x1080 masters.
- Create 1080x1920 and 1080x1080 reframes.
- Add platform-specific captions and final campaign tracking URLs.
