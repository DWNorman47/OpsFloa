param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\public\audio\plan-to-paid\voice-draft.wav')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path (Split-Path $OutputPath) | Out-Null

$script = @'
Every job starts with a plan. Then the real work begins. Crews move. Quantities change. Costs hit. Payroll is due. OpsFloa keeps the operation in one live flow: takeoff, estimating, field time, job costs, billing, and payroll. Less chasing. Fewer surprises. From plan to paid. OpsFloa.
'@

$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$preferredVoice = $speaker.GetInstalledVoices() |
  Where-Object { $_.Enabled -and $_.VoiceInfo.Name -eq 'Microsoft Mark' } |
  Select-Object -First 1
if ($preferredVoice) {
  $speaker.SelectVoice($preferredVoice.VoiceInfo.Name)
}
$speaker.Rate = 1
$speaker.Volume = 100

try {
  $speaker.SetOutputToWaveFile($OutputPath)
  $speaker.Speak($script.Trim())
  $speaker.SetOutputToNull()
  Write-Output "Generated $OutputPath"
} finally {
  $speaker.Dispose()
}
