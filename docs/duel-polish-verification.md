# 勝敗と改造を主役にしたPC画面

2026-09-12 / #60。参考画像の金色の筐体、左右の対決、赤い再戦ボタンを保ち、結果と選ぶ作戦の見え方を改善した。

- 結果は勝利の金色、敗北の青色、引き分けの中間色に分けた。勝敗、両者のコイン、点差を先に表示し、配当と改造の内訳は開閉できる。内訳を開いても再戦ボタンへ重ならない。
- 勝利時は既存のThree.jsと24枚の金貨を使って約2.2秒の演出を加えた。描画器・画像素材・リール出目は増やさず、敗北・引き分けでは金貨を出さない。演出後は連続描画を止め、モーション軽減・非表示・再戦時の停止に対応する。
- 改造は安定型の金色と大勝負の赤紫色で分け、キー1/2、残り時間、減るバー、カード内の選択済み表示を大きくした。安定型は改造後の当たり率、大勝負は改造後の7揃い率を強調する。
- 60秒・30回転・2回の改造というゲーム規則は維持。PC専用のまま。CPU入口に外部APIを追加していない。

## 実画面

[勝利・金貨](evidence/duel-polish/victory-1280.webp)、[敗北](evidence/duel-polish/defeat-1280.webp)、[引き分け](evidence/duel-polish/draw-1280.webp)、[改造選択](evidence/duel-polish/upgrade-1280.webp) は1280×720のDEV表示。固定結果は本番に含まれない。[表示値](evidence/duel-polish/fixture-cases.json)も記録した。

1920×1080の通常CPU対戦では、予告中のキー2を受け付けず、20秒に大勝負、40秒に安定型を選択。カード内の「この作戦でいく」を確認した。[最終調整後の選択表示（DEV）](evidence/duel-polish/selected-1920.webp)。

60秒後は720対240の勝利。プレイヤーはチェリー480点＋ベル240点、ライバルはチェリー240点で表示合計と一致。内訳を開いたパネル下端760.7px、再戦ボタン上端787.4pxで重なりなし。[結果の内訳](evidence/duel-polish/local-details-1920.webp)。再戦で0点・60秒・内訳0行・折りたたみ初期化、Enterでカウントダウン取消を確認。[操作記録](evidence/duel-polish/local-flow.json)。JavaScriptエラー0。

この変更で新しい自動テストは作っていない。既存190テスト、型検査、lint、本番ビルドは成功。主JS135.58KB gzip、CSS4.99KB gzip。500KB超の既存ビルド警告は残る。

## 公開反映

PR #61をマージし、コード `1d1ac8d10020cf8c86f0d37e0f86704be8f16949` を https://slot-chan.vercel.app に公開。Vercel `dpl_FiK4BZ2BrttDeiZrqM8heKant336` READY、[マージ後CI成功](https://github.com/yuin15/donburi-g/actions/runs/34677582813)。#60はクローズ。

公開Chromeの1280×720で安定型→大勝負をキー1→2で選び、480対2,880の敗北まで確認。内訳合計・改造順・点差が一致した。内訳を開いてもパネル下端510.6pxと再戦ボタン上端525.3pxの間に余白があり、Enterで閉じられる。再戦で0点・60秒・内訳0行・折りたたみ初期化を確認。外部/API通信0、JavaScriptエラー0。公開の任意Liveは無効のまま、HTTP 401 / WebSocket拒否1008も確認した。

[公開の選択状態](evidence/duel-polish/public-selected-1280.webp)、[公開の結果](evidence/duel-polish/public-result-1280.webp)、[操作・表示・読み込み記録](evidence/duel-polish/public-flow.json)。公開JS `index--xLC7qNX.js`、CSS `index-D_x-kPYE.css` が検証版と一致する。
