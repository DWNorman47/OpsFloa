param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\public\audio\field-payroll')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$lines = @(
  @{ File = '01-hook.wav'; Text = 'The job moved. Did the paperwork?' },
  @{ File = '02-clock-in.wav'; Text = 'With OpsFloa, crews clock in to the right project in seconds.' },
  @{ File = '03-oversight.wav'; Text = "Operations sees who's working, where, and how every hour should be assigned." },
  @{ File = '04-approval.wav'; Text = 'Review, split, and approve time without chasing down the details.' },
  @{ File = '05-payroll.wav'; Text = 'Pay rules and deductions are applied automatically.' },
  @{ File = '06-close.wav'; Text = 'From field to payroll, one flow. OpsFloa.' }
)

$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$preferredVoice = $speaker.GetInstalledVoices() |
  Where-Object { $_.Enabled -and $_.VoiceInfo.Name -eq 'Microsoft Mark' } |
  Select-Object -First 1
if ($preferredVoice) {
  $speaker.SelectVoice($preferredVoice.VoiceInfo.Name)
}
$speaker.Rate = -1
$speaker.Volume = 100

try {
  foreach ($line in $lines) {
    $path = Join-Path $OutputDirectory $line.File
    $speaker.SetOutputToWaveFile($path)
    $speaker.Speak($line.Text)
    $speaker.SetOutputToNull()
    Write-Output "Generated $path"
  }
} finally {
  $speaker.Dispose()
}
