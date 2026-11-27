// The suite runs the same on any machine: nothing from the shell that started it reaches muster's code.
// A developer with MUSTER_PROFILE exported would otherwise run every test as that profile.
// MUSTER_BACKEND stays: it is how the suite is asked to run against `mu serve` instead of the file.
for (const name of Object.keys(process.env)) if (name.startsWith('MUSTER_') && name !== 'MUSTER_BACKEND') delete process.env[name]
process.env.TZ = 'UTC'
process.env.LANG = 'en_US.UTF-8'
delete process.env.LC_ALL
