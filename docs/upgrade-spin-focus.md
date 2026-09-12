# 改造開始時もSpaceを回転に保つ

Issue #70。手動回転の導入後も、20秒・40秒に最初の改造ボタンへ自動でフォーカスする処理が残っていた。Space連打中に改造が開くと、回すための次のSpaceが安定型のボタン操作になり、意図しない選択が発生した。

改造パネルは試合を止めないため、自動フォーカスを削除して現在の操作位置を維持する。改造はクリック、数字キー1/2、Tabで選べる。意図的にTabで選択ボタンへ移動した場合の標準キーボード操作は維持する。

ローカルChromeの通常対戦で、40秒の改造開始をSpace連打で通過。フォーカスは`start`、ボタンは予約済み、改造は未選択のままだった。その後2キーで大勝負だけが選択済みになった。[観測記録](evidence/rival-feedback/upgrade-focus-local.json)。型検査・lint・本番ビルド成功。既存の500KB超ビルド警告は残る。

PR #71を公開し、Vercel `dpl_9ZdVpeHgNJ3hn3vrWEp9CWTED3rL` はREADY。公開コード `f301e304a77bed217fed613ee0774b16aa2c23c9`、マージ後CI [34680128763](https://github.com/yuin15/donburi-g/actions/runs/34680128763) 成功。公開Chromeで20秒の改造開始をSpace連打で通過し、残り39秒でも未選択・`start`フォーカス・予約済みが続いた。2キーで大勝負だけが選択済みになることを確認。JavaScriptエラー0。[公開観測](evidence/rival-feedback/upgrade-focus-public.json)。
