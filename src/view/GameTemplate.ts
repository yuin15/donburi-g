import { PAYOUT } from '../domain/game';

/** PC stage markup. Game rules and state transitions live outside this view. */
export function mountGameTemplate(app: HTMLElement): void {
app.innerHTML = `
<section class="shell" inert>
  <h1 class="sr-only">Slot-chan</h1>
  <div id="stageArt" aria-hidden="true"></div>
  <div class="countdown" id="countdown" tabindex="-1" role="group" aria-label="Match countdown" aria-describedby="countdownHelp" hidden>
    <div class="countdown-card"><span class="countdown-caption">60 SECOND DUEL</span><strong id="countdownValue">3</strong>
      <p id="countdownHelp"><kbd>SPACE</kbd> / CLICK TO SPIN<small>Your rival spins automatically. Ready?</small></p>
    </div>
  </div>
  <header class="topbar">
    <div class="timer" id="timer" aria-label="Time remaining"><small>TIME LEFT</small><b id="time">1:00</b></div>
    <div class="status-cluster" id="status"><span id="modeBadge">CPU DUEL</span><button id="sound" aria-label="Mute AI voice" aria-pressed="false" hidden>VOICE ON</button><button id="effects" aria-label="Mute sound effects" aria-pressed="false">SOUND ON</button><button id="leave">EXIT</button></div>
  </header>
  <div class="scores">
    <div class="you" id="playerScore"><span class="score-name"><i aria-hidden="true">♛</i><b>YOU</b><small><em id="roundCount">00</em> SPINS</small></span><strong id="ps">0</strong><span class="score-meter" aria-hidden="true"><i id="playerMeter"></i></span></div>
    <div class="rival" id="rivalScore"><span class="score-name"><i aria-hidden="true">♜</i><b>RIVAL</b><small><em id="rivalRoundCount">00</em> SPINS</small></span><strong id="rs">0</strong><span class="score-meter" aria-hidden="true"><i id="rivalMeter"></i></span></div>
    <span class="duel-gap" id="scoreGap" role="status">EVEN</span>
  </div>
  <section class="machine" aria-label="Your slot machine">
    <div id="machineTitle"><span>WIN</span><strong id="pay" aria-live="polite">0</strong></div>
    <div class="event-cue" id="eventCue" role="status" hidden></div>
    <div class="sr-only" id="lastSpin">Cherry, Bell, Seven</div>
    <div id="machineTrim">3 MATCHING SYMBOLS · CENTER LINE</div>
  </section>
  <aside class="avatar">
    <span class="sr-only" id="mockFace">CPU rival</span>
    <video id="avatar" autoplay playsinline></video>
    <span id="rivalMood">60 seconds. Let's play.</span><p id="line">Think you can beat me?</p><small id="heard"></small>
    <div id="miniLabel"><span id="rivalWinLabel">RIVAL REELS</span><strong id="rivalPay" hidden></strong></div>
    <strong class="sr-only" id="rivalReels">Cherry, Bell, Seven</strong>
    <div id="duelRules"><strong>MOST COINS WINS</strong><span>AUTO RIVAL · ONE SPIN EVERY 2s</span></div>
    <div class="connection" id="connection"></div>
  </aside>
  <footer>
    <section class="result" id="result" aria-labelledby="resultTitle" hidden>
      <small id="resultRounds">60 SECOND DUEL</small>
      <div class="result-heading" role="status" aria-atomic="true"><div><span id="resultEnglish" aria-hidden="true"></span><h2 id="resultTitle"></h2></div><span class="result-emblem" aria-hidden="true"></span></div>
      <div class="result-score" id="resultScore"><div><small>YOUR COINS</small><strong id="resultPlayer"></strong></div><span>VS</span><div><small>RIVAL COINS</small><strong id="resultRival"></strong></div></div>
      <p id="resultGap"></p>
      <details id="resultDetails"><summary>ROUND STATS <span aria-hidden="true">＋</span></summary><table aria-label="Match coin breakdown"><thead><tr><th scope="col">COIN BREAKDOWN</th><th scope="col">YOU</th><th scope="col">RIVAL</th></tr></thead><tbody id="resultStats"></tbody></table></details>
      <p class="result-again" id="resultAgain">One more round?</p>
    </section>
    <button id="start" disabled>PLAY</button><span id="spinHint" aria-live="polite">CLICK / SPACE TO SPIN</span>
    <div id="paytable" aria-label="Three cherries pay 120, bells 240, sevens 1200"><span><small>×3</small><i class="symbol-icon cherry"></i>${PAYOUT.cherry}</span><span><small>×3</small><i class="symbol-icon bell"></i>${PAYOUT.bell}</span><span><small>×3</small><i class="symbol-icon seven"></i>1,200</span></div>
    <div id="roundStatus"><kbd>SPACE</kbd><small id="queueStatus">CLICK TO SPIN</small></div>
  </footer>
</section>
<div class="gate" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="gate-card">
    <div class="eyebrow">60 SECOND DUEL</div>
    <h2 id="gateTitle">SPIN FAST.<br><em>BEAT YOUR RIVAL.</em></h2>
    <p>Click or press SPACE to spin.<br>Your rival spins automatically.<br>Win the most coins in 60 seconds.</p>
    <p class="gate-strategy">Match 3 symbols on the center line.<br>Three 7s win 1,200 coins.<br>Every spin could turn the game.</p>
    <div class="gate-payout"><span class="symbol-icon cherry"></span><span class="symbol-icon bell"></span><span class="symbol-icon seven"></span><span>One more press?<br>Your next spin is queued.</span></div>
    <button id="practice" class="primary">PLAY NOW <span>→</span></button>
    <small>Free · No mic needed · Desktop 1280×720 or larger</small>
    <details class="voice-options"><summary>ADD AI VOICE · OPTIONAL</summary>
      <p>Talk to your rival while you play. Microphone audio is sent to OpenAI. An invite is required. Connections close after the match; conversations are not stored.</p>
      <label>Invite code<input id="invite" type="password" autocomplete="off" placeholder="Invite code"></label>
      <label class="voice-video-option"><input id="avatarVideo" type="checkbox">Add live video · uses LiveAvatar credits</label>
      <button id="liveConnect">CONNECT AI VOICE</button>
    </details>
    <small id="gateMessage" role="status">CPU play needs no external AI service.</small>
  </div>
</div>
`;
}
