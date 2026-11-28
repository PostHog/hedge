# Boxes is the only caller of a Box backend

Setup, `hedge box`, and the Hub pack's links reach a box that Hedge manages only through the Boxes engine module, which owns the pool, the claims, the box lock, the lifecycle, and the idle sweep. Nothing else calls a backend or the Coder CLI. Before this, 19 `coder.ssh` calls and 6 setup operations reached Coder directly, so a second backend would have needed changes in every caller.
