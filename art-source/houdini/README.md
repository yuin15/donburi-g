# 立体コインの制作元

HoudiniのPython SOPで、厚みのある本体、二重の縁、刻みのある側面、両面の7を組み立てます。形状はスクリプトで再生成でき、特定のフォントや外部素材に依存しません。

## 再生成

Houdiniをインストールし、無料のApprenticeライセンスを有効にしてから、Houdini付属の`hython`で次を実行します。

```powershell
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_coin.py
```

- `exports/slot-chan-coin.obj`: ゲームへ取り込む形状。Gitへ含めます。
- `.art-build/slot-chan-coin.hipnc`: 編集用のHoudiniシーン。リポジトリのルートに生成し、Gitへ含めません。

編集用シーンの`/obj/slot_chan_coin/procedural_coin`で、円周の分割数と側面の刻み数を変更できます。形状の断面と7の比率は`build_coin.py`で調整します。

OBJは無料版で対応する書き出し形式です。制作に利用したApprenticeは非商用向けのため、この素材もゲームソンの非商用デモ向けとして扱ってください。商用化する場合は、制作ライセンスと素材の扱いをSideFXの条件に照らして確認してください。

アカウント情報、ライセンスファイル、個人のメールアドレスは制作元にも書き出し先にも保存しません。

参考: [Houdini製品比較](https://www.sidefx.com/products/compare/)、[Apprenticeの条件](https://www.sidefx.com/get/try-houdini/)、[Python SOP](https://www.sidefx.com/docs/houdini/nodes/sop/python.html)。
