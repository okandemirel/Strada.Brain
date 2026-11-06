# Strada Brain Daemon Triggers

Every trigger defined here turns each of its fires into an agent task, and an
agent task is a model run. Define a trigger only for work that needs a model
every time it fires.

The project's health is not a trigger. The real-tree guardian
(`src/daemon/real-tree-guardian.ts`) checks it without a model: it compiles the
project every 15 minutes and after every write-back, and plays it once a
write-back changed it. It opens one fix task only when the compile names an
error or the play-through fails.
