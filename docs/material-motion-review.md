# Material and motion review

Review preview: https://slot-chan-material-review.nsns202604.chatgpt.site

Integration proposal: https://github.com/yuin15/donburi-g/pull/125 (Draft; production is not changed by publishing the review page).

## Included in this update

- **Lever:** the existing Houdini arm, knob and collar are separate named groups around their original mount. A 720ms pull/hold/spring-return accompanies an accepted player spin. Rival spins do not move it. Reduced motion and stop/reset restore the neutral pose.
- **Coins:** the existing 24-coin pool and 650/1200ms win lifetimes are retained. Coins fan out beside the reels/portrait, then accelerate and shrink into their own balance label. A brief glint marks arrival. Score positions come from `StageLayout.OVERLAYS`, not an unrelated hard-coded screen location. No game balance or payout calculations are delayed or changed.
- **Gold sweep:** a thin travelling highlight is restricted to the gold finish, accompanied by a stronger moving point light. The light remains enabled on the cabinet layer as well as the foreground effects layer. No permanent idle animation or shadow-map regeneration was added.
- **Cherries:** fruit no longer uses red cabinet enamel or metal strip-light reflections. It uses a red dielectric material and two soft, localized spherical light lobes. This retains the small bright highlight and curved edge sheen without bright bands enclosing the highlight. Reel atlas, lifted winning cherries, small rival reels and payout icons use the same material.

## Asset preservation

Only six OBJ group lines were added to tag the moving lever. Vertex positions, normals and face references are unchanged. The Houdini generator uses the same names on subsequent exports. The gold mounting ball stays on the fixed cabinet. No Houdini recook or shape changes were required for this group-only migration.

## Review controls

`通常` + `質感を拡大` makes cherry reflections easy to inspect. `回転を見る` replays miss → bell → cherry → jackpot to inspect the lever, gold sweep and collection. `比較元` switches between the previous material proposal and the original main revision. Both comparison panes use the same fixed outcomes. The preview is fixture-only and makes no API or microphone connection.

## Verification boundaries

The existing scene tests cover the lever's pulled/neutral poses, reduced motion, collection endpoints for both balances, independent win lifetimes, portrait avoidance, resource cleanup and no idle render loop. Browser review covers the actual WebGL materials and animation rendering, which mocked renderers cannot prove. The complete existing CI commands are run before updating the proposal; GitHub's external-fork CI may still require a maintainer action. Visual approval, PR merge and the separate Vercel production publication remain pending.
