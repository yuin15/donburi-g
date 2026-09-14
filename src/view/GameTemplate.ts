import { ACTIVE_LINES, BETS, PAYOUT } from '../domain/game';
import type { WinningLine } from '../../shared/protocol';

const BET_LINE_DIAGRAMS: Record<WinningLine, string> = {
  top: 'M3 4H43', middle: 'M3 17H43', bottom: 'M3 30H43',
  diagonalDown: 'M3 4 43 30', diagonalUp: 'M3 30 43 4',
};

const betButtons = BETS.map(bet => `<button type="button" data-bet="${bet}" aria-pressed="false" aria-label="Bet $${bet}, ${bet} ${bet === 1 ? 'line' : 'lines'} per spin">
  <svg class="bet-diagram" viewBox="0 0 46 34" aria-hidden="true"><path class="bet-grid" d="M1 1H45V33H1Z M15.5 1V33 M30.5 1V33 M1 11.5H45 M1 22.5H45"/><path class="bet-lines" d="${ACTIVE_LINES[bet].map(line => BET_LINE_DIAGRAMS[line]).join(' ')}"/></svg>
  <span class="bet-label"><strong>$${bet}</strong><em>${bet} ${bet === 1 ? 'LINE' : 'LINES'}</em></span><span class="bet-selected" aria-hidden="true">✓</span>
</button>`).join('');

/** PC stage markup. Game rules and state transitions live outside this view. */
export function mountGameTemplate(app: HTMLElement): void {
app.innerHTML = `
<section class="shell" inert>
  <h1 class="sr-only">Slot-chan</h1>
  <div id="stageArt" aria-hidden="true"></div>
  <div id="stageEffects" aria-hidden="true"></div>
  <div class="countdown" id="countdown" tabindex="-1" role="group" aria-label="Match countdown" aria-describedby="countdownHelp" hidden>
    <div class="countdown-card"><span class="countdown-caption">60 SECOND DUEL</span><strong id="countdownValue">3</strong>
      <p id="countdownHelp"><kbd>SPACE</kbd> / CLICK TO SPIN<small>Your rival spins automatically. Ready?</small></p>
    </div>
  </div>
  <header class="topbar">
    <div class="timer" id="timer" aria-label="Time remaining"><small id="timerCaption">TIME LEFT</small><b id="time">1:00</b><span id="timeExtension" aria-live="assertive" hidden></span></div>
    <div class="status-cluster" id="status"><span id="modeBadge">CPU DUEL</span><button id="sound" aria-label="Mute AI voice" aria-pressed="false" hidden>VOICE ON</button><button id="effects" aria-label="Mute sound effects" aria-pressed="false">SOUND ON</button><button id="leave">EXIT</button></div>
  </header>
  <div class="scores">
    <div class="you" id="playerScore"><span class="score-name"><i aria-hidden="true"><svg viewBox="0 0 40 48"><path d="M4 5 20 1 36 5v22c0 10-16 19-16 19S4 37 4 27Z"/><path d="m10 17 6 5 4-12 4 12 6-5-3 15H13Z"/><path d="M13 36h14"/></svg></i><b>YOU</b><small><em id="roundCount">00</em> SPINS</small></span><strong id="ps">0</strong><span class="score-meter" aria-hidden="true"><i id="playerMeter"></i></span></div>
    <div class="rival" id="rivalScore"><span class="score-name"><i aria-hidden="true"><svg viewBox="0 0 40 48"><path d="M4 5 20 1 36 5v22c0 10-16 19-16 19S4 37 4 27Z"/><path d="m20 9 3.6 10.4L31 23l-7.4 3.6L20 37l-3.6-10.4L9 23l7.4-3.6Z"/></svg></i><b>RIVAL</b><small><em id="rivalRoundCount">00</em> SPINS</small></span><strong id="rs">0</strong><span class="score-meter" aria-hidden="true"><i id="rivalMeter"></i></span></div>
  </div>
  <section class="machine" aria-label="Your slot machine">
    <div id="machineTitle"><span id="winLabel">MATCH 3 · WIN BIG</span><strong id="pay" aria-live="polite">0</strong></div>
    <div class="event-cue" id="eventCue" role="status" hidden></div>
    <div class="loan-transfer" id="loanTransfer" role="status" aria-live="assertive" hidden><small>LOAN</small><strong id="loanDirection"></strong><b id="loanAmount"></b></div>
    <div class="win-burst" id="winBurst" aria-hidden="true" hidden><small id="winBurstLabel">BIG WIN</small><strong id="winBurstAmount"></strong><span>COINS</span></div>
    <div id="betControls" role="group" aria-label="Choose your bet"><small>BET</small>${betButtons}</div>
    <span id="betStatus" class="sr-only" role="status" aria-live="polite"></span>
    <div id="lineIndicators" role="group" aria-label="Active lines for the next spin">
      ${([
        ['diagonalDown', 'diagonal-down', 5, 'diagonal down', 'M85 12 101 28 M89 28H101V16'],
        ['top', 'top', 3, 'top row', 'M82 20H103 M95 12 103 20 95 28'],
        ['middle', 'middle', 1, 'middle row', 'M82 20H103 M95 12 103 20 95 28'],
        ['bottom', 'bottom', 3, 'bottom row', 'M82 20H103 M95 12 103 20 95 28'],
        ['diagonalUp', 'diagonal-up', 5, 'diagonal up', 'M85 28 101 12 M89 12H101V24'],
      ] as const).map(([line, position, bet, label, arrow]) => `<svg class="line-indicator ${position}" data-line="${line}" viewBox="0 0 120 40" role="img" aria-label="$${bet} ${label}" style="--line-idle-fill:url(#line-idle-${line});--line-gold-fill:url(#line-gold-${line});--line-edge-fill:url(#line-edge-${line})">
        <defs>
          <linearGradient id="line-idle-${line}" x2="0" y2="1"><stop stop-color="#537456"/><stop offset=".48" stop-color="#11271c"/><stop offset=".54" stop-color="#294a32"/><stop offset="1" stop-color="#173324"/></linearGradient>
          <linearGradient id="line-gold-${line}" x2="0" y2="1"><stop stop-color="#fff3b9"/><stop offset=".4" stop-color="#e9b43b"/><stop offset=".49" stop-color="#a9710f"/><stop offset=".56" stop-color="#ffdf78"/><stop offset="1" stop-color="#d19828"/></linearGradient>
          <linearGradient id="line-edge-${line}" x2=".35" y2="1"><stop stop-color="#fffad7"/><stop offset=".25" stop-color="#c28c30"/><stop offset=".48" stop-color="#fff5c0"/><stop offset=".73" stop-color="#a26513"/><stop offset="1" stop-color="#f5d78a"/></linearGradient>
        </defs>
        <rect class="line-plate" x="2" y="3" width="116" height="34" rx="7"/><path class="line-reflection" d="M10 6H110Q115 6 115 12V18Q61 10 5 18V12Q5 6 10 6"/><circle class="line-lamp" cx="14" cy="20" r="4"/><text x="49" y="21">$${bet}</text><path class="line-direction" d="${arrow}"/>
      </svg>`).join('')}
    </div>
    <div id="betLinePreview" aria-hidden="true" hidden><svg viewBox="0 0 650 371">
      <path data-preview-line="middle" d="M94 185.5H650" pathLength="1"/>
      <path data-preview-line="top" d="M94 50.8H650" pathLength="1"/>
      <path data-preview-line="bottom" d="M94 320.2H650" pathLength="1"/>
      <path data-preview-line="diagonalDown" d="M94 -14.8 183 50.8 372 185.5 561 320.2H650" pathLength="1"/>
      <path data-preview-line="diagonalUp" d="M94 385.8 183 320.2 372 185.5 561 50.8H650" pathLength="1"/>
    </svg></div>
    <div class="sr-only" id="lastSpin">Cherry, Bell, Seven</div>
    <div id="machineTrim">CHOOSE BET · ACTIVE LINES PAY</div>
  </section>
  <aside class="avatar">
    <span class="sr-only" id="mockFace">CPU rival</span>
    <video id="avatar" autoplay playsinline></video>
    <span id="rivalMood">60 seconds. Let's play.</span><p id="line">Think you can beat me?</p><small id="heard"></small>
    <section id="textChoice" aria-live="assertive" aria-label="CPU decision" hidden><small id="textChoiceKind"></small><strong id="textChoiceQuestion"></strong><span id="textChoiceDetail"></span><small class="text-choice-expiry">REPLY WITHIN 5 SEC</small><div><button id="textChoiceAccept"></button><button id="textChoiceDecline"></button></div></section>
    <div id="miniLabel"><span id="rivalWinLabel">RIVAL REELS · BET $1</span><strong id="rivalPay" hidden></strong></div>
    <strong class="sr-only" id="rivalReels">Cherry, Bell, Seven</strong>
    <div id="duelRules"><strong>MOST CASH WINS</strong><span>AUTO RIVAL · ONE SPIN EVERY 2s</span></div>
    <div id="voicePanel" aria-label="Microphone controls" hidden>
      <button id="mic" aria-label="Mute your microphone" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/><path class="mic-slash" d="M3 3l18 18"/></svg>
        <span id="micLabel">MIC ON</span>
      </button>
      <span class="mic-meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <div class="mic-copy"><strong id="micState">MIC LIVE</strong><small id="micHint">Talk while you play.</small></div>
    </div>
    <div class="connection" id="connection"></div>
  </aside>
  <footer>
    <section id="upgradeShop" aria-label="Upgrade your machine">
      <h2>UPGRADE</h2>
      <div class="shop-row"><i class="symbol-icon cherry" aria-hidden="true"></i><span>+6</span><button id="buySteady" aria-describedby="steadyLevel" disabled>BUY $10</button><span class="sr-only" id="steadyLevel">4 cherries in reel. This match only.</span></div>
      <div class="shop-row"><i class="symbol-icon seven" aria-hidden="true"></i><span>+1</span><button id="buyJackpot" aria-describedby="jackpotLevel" disabled>BUY $10</button><span class="sr-only" id="jackpotLevel">2 sevens in reel. This match only.</span></div>
      <span class="sr-only" id="purchaseNotice" role="status">BUY → BOOST YOUR NEXT SPIN</span>
      <i id="purchaseSymbol" aria-hidden="true"></i>
    </section>
    <section class="result" id="result" aria-labelledby="resultTitle" hidden>
      <small id="resultRounds">60 SECOND DUEL</small>
      <div class="result-heading" role="status" aria-atomic="true"><div><span id="resultEnglish" aria-hidden="true"></span><h2 id="resultTitle"></h2></div><span class="result-emblem" aria-hidden="true"></span></div>
      <div class="result-score" id="resultScore"><div><small>YOUR CASH</small><strong id="resultPlayer"></strong></div><span>VS</span><div><small>RIVAL CASH</small><strong id="resultRival"></strong></div></div>
      <p id="resultGap"></p>
      <div class="result-records" id="resultRecords"><div><small id="recordLabel">SESSION BEST</small><strong id="recordCoins">$0</strong></div><div><small>WIN STREAK</small><strong id="recordStreak">0</strong></div></div>
      <details id="resultDetails"><summary>ROUND STATS <span aria-hidden="true">＋</span></summary><table aria-label="Match coin breakdown"><thead><tr><th scope="col">COIN BREAKDOWN</th><th scope="col">YOU</th><th scope="col">RIVAL</th></tr></thead><tbody id="resultStats"></tbody></table></details>
      <p class="result-again" id="resultAgain">One more round?</p>
    </section>
    <button id="start" disabled>PLAY</button><span id="spinHint" aria-live="polite"></span>
    <div id="paytable" aria-label="Each winning line pays cherries 3, bells 6, sevens 30"><span><small>LINE</small><i class="symbol-icon cherry"></i>${PAYOUT.cherry}</span><span><small>LINE</small><i class="symbol-icon bell"></i>${PAYOUT.bell}</span><span><small>LINE</small><i class="symbol-icon seven"></i>${PAYOUT.seven}</span></div>
    <div id="roundStatus"><kbd id="spaceKey">SPACE</kbd><div id="bestRun" hidden><small>SESSION BEST</small><strong id="bestScore"></strong></div><small id="queueStatus">CLICK TO SPIN</small></div>
  </footer>
</section>
<div class="gate" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="gate-card">
    <div class="eyebrow">60 SECOND DUEL</div>
    <h2 id="gateTitle">PICK YOUR BET.<br><em>BEAT YOUR RIVAL.</em></h2>
    <p>Click or press SPACE after the reels stop.<br>Your rival spins automatically.<br>Finish with more cash in 60 seconds.</p>
    <p class="gate-strategy">Start with $30. Pick $1, $3, or $5.<br>More BET unlocks more lines.<br>Every spin could turn the game.</p>
    <div class="gate-payout"><span class="symbol-icon cherry"></span><span class="symbol-icon bell"></span><span class="symbol-icon seven"></span><span>Pick your risk.<br>No queued spins.</span></div>
    <section class="voice-options" aria-labelledby="voiceOptionsTitle">
      <h3 id="voiceOptionsTitle">ADD AI VOICE · OPTIONAL</h3>
      <p>Talk to your rival while you play. Microphone audio is sent to OpenAI. An invite is required. Connections close after the match; conversations are not stored.</p>
      <label>Invite code<input id="invite" type="password" autocomplete="off" placeholder="Invite code"></label>
      <label class="voice-video-option" hidden><input id="avatarVideo" type="checkbox">Add live video · uses LiveAvatar credits</label>
      <button id="liveConnect" class="primary">CONNECT AI VOICE <span>→</span></button>
    </section>
    <button id="practice" class="secondary">PLAY NOW <span>→</span></button>
    <small>Free · No mic needed · Desktop 1280×720 or larger</small>
    <small id="gateMessage" role="status">CPU play needs no external AI service.</small>
  </div>
</div>
`;
}
