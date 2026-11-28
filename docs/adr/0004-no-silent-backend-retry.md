# No silent retry on a backend failure

When a backend fails, Boxes drops the forwards the attempt made, keeps the box for diagnosis, and stops with the cause and the next command, such as `hedge box sweep` on a quota error. It never repeats the call on its own. A retry on a quota or a slow start makes a second box that costs money, and hides the failure from the person who must fix it.
