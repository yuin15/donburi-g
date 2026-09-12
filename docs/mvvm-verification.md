# MVVMへの移行確認

Issue #72。約1,100行の`main.ts`を40行の起動・結線・破棄へ整理した。ViewModelに対戦進行・CPU/Liveイベント・予約・時計・表示状態を移し、ViewにDOM・フォーカス・Three.js・音の実行を分けた。詳細は[構成と変更箇所](architecture.md)。

## 保持した動作

- 既存の抽選・配当・改造・サーバー規則を維持。DOMなしの`RoundPresentation`と`RivalReactions`はViewModelのフォルダーへ移した。
- Viewは確定snapshotと表示済みscoresを別々に受け取る。回転停止のcallbackで両得点を更新し、最終停止を待って結果を表示する。
- クリックとSpace、予約1回、数字キー1/2の改造、改造開始でのフォーカス保持、相手の加点を維持。
- LiveClientの遅延読み込み・メディア終了処理は既存実装を使用し、factoryで注入する。ViewModelに動画要素やDOMイベントを渡さない。
- 古いCPU時計ラッパーと4テストを削除し、注入時計を使うViewModelの6境界テストへ移した。既存のドメイン・通信・描画テストは維持。
- DEV固定画面はViewへ表示状態を渡す独立モジュールへ移した。Live字幕の固定表示は画面検収用で、実際の字幕順序はViewModelテストで確認する。本番VMに任意の状態書換APIは追加していない。

## 確認結果

- 型検査、lint、210テスト、Node ESMの起動と拒否応答、本番ビルド成功。
- ローカルChromeで25回転、1,440対360の勝利。安定型を選び、未選択の2回目は既定の安定型になった。得点・配当内訳が一致し、結果詳細を開いたまま効果音を切り替えても開閉状態を維持した。再戦で0点・0回・内訳0行・閉じた状態へ初期化。
- 再戦では20秒・40秒の両方で2キーを押して大勝負を選択。連打予約を続け、26回転、720対1,200の敗北まで確認。どちらの対戦もJavaScriptエラー0。
- 1280×720の同時7揃いと1920×1080の結果詳細を目視。筐体・絵柄・青と金の加点を維持し、結果パネルと再戦ボタンが重ならない。
- 移動したDEV回転検収ツールで4回転と停止後の表示を確認。384標本、中央値17.6ms、p95 18.1ms、最大33描画・252三角形・素材4点。実行PC上の観測で、端末全体の性能保証ではない。
- 主JSは141.06KB gzip、CSSは5.48KB gzip。移行前の主JS137.99KB gzipから約3.1KB増加。新しい描画・MVVMフレームワークは追加していない。既存の500KB超ビルド警告は残る。

![同時7揃い](evidence/mvvm/both-jackpot-1280.webp)
![結果詳細と再戦ボタン](evidence/mvvm/result-1920.webp)

観測: [初回対戦](evidence/mvvm/local-flow.json)、[再戦](evidence/mvvm/local-rematch-flow.json)、[DEV回転計測](evidence/mvvm/dev-motion.json)。

実APIによる任意の音声・映像の接続確認は行っていない。今回の整理は、残っている実API・実機確認を完了扱いにするものではない。

## 公開確認

PR #73、コード `2e749af13e13c526f7cb2dfcaef75b4fbdbf4350` をVercel `dpl_Ft8atN2hnqA8ChSJY2mgJtuoTPjN`（READY）へ反映。マージ後CI [34684527781](https://github.com/yuin15/donburi-g/actions/runs/34684527781) 成功。

公開Chromeで37回転、1,200対2,160の敗北まで確認。最初は2キーで大勝負を選択し、2回目は操作間隔が空いたため既定の安定型が適用された。期限後の1キー入力で変更されないことも確認。表示の得点・配当内訳・最高の一回・改造順が一致し、最後の回転は停止後に結果へ移った。

結果詳細を開いて効果音を切り替えても詳細は開いたまま。再戦は0点・0回・60秒・内訳0行・閉じた状態へ初期化された。外部/API通信0、JavaScriptエラー0。新JS `index-DR4oln0M.js`、CSS `index-BgFTt2wz.css`、DEVツールなし。

![公開版の対戦画面](evidence/mvvm/public-playing-1280.webp)
![公開版の結果詳細](evidence/mvvm/public-result-1280.webp)

公開観測: [public-flow.json](evidence/mvvm/public-flow.json)。
