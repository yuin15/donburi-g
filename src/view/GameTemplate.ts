import { BETS, PAYOUT } from '../domain/game';

const betButtons = BETS.map(bet => `<button type="button" data-bet="${bet}" aria-pressed="false" aria-label="Bet $${bet}, ${bet} ${bet === 1 ? 'line' : 'lines'} per spin"><span>$${bet} · ${bet} ${bet === 1 ? 'LINE' : 'LINES'}</span></button>`).join('');
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
    <div class="mutual-bonus" id="mutualBonus" role="status" aria-live="assertive" hidden><small>BONUS</small><strong id="bonusDirection">YOU + RIVAL</strong><b id="bonusAmount"></b></div>
    <div class="win-burst" id="winBurst" aria-hidden="true" hidden><small id="winBurstLabel">BIG WIN</small><strong id="winBurstAmount"></strong><span>COINS</span></div>
    <div id="betControls" role="group" aria-label="Choose your bet"><small>BET</small>${betButtons}</div>
    <span id="betStatus" class="sr-only" role="status" aria-live="polite"></span>
    <div id="lineIndicators" role="group" aria-label="Active lines for the next spin">
      ${([
        ['diagonalDown', '$5 diagonal down'], ['top', '$3 top row'], ['middle', '$1 middle row'],
        ['bottom', '$3 bottom row'], ['diagonalUp', '$5 diagonal up'],
      ] as const).map(([line, label]) => `<span data-line="${line}" role="img" aria-label="${label}"></span>`).join('')}
    </div>
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
