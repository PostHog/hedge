# The Mac runs only T3 Code

Hedge sets up only Linux cloud boxes. The Mac and the phone run the T3 Code app and reach the boxes through T3 Connect, which setup turns on for each box with `t3 up --connect --headless`. We dropped the Mac setup, SSH routes, and Coder port forwards from the Mac because each was a second way to do the same thing, and they made setup slower and the tests larger. The cost is the T3 Connect limit on how many machines one account links.
