// A stand-in Host for the checker's own tests. It reports each stage's expected
// outcome, with the one fault named as its root, so a weakened check shows up.
const FAULTS = {
  // Class order isn't a protocol requirement, so this one must still pass.
  reversed: (observations) => {
    for (const result of observations) {
      result.descriptor.class.reverse();
      result.effective.classes.reverse();
    }
  },
  "unknown-class": (observations, vector) => {
    if (vector.rfcVector === 1) observations[0].effective.classes.push("quantum");
  },
  descriptor: (observations, vector) => {
    if (vector.rfcVector === 1) observations[0].descriptor.class = [];
  },
  source: (observations, vector) => {
    if (vector.rfcVector === 6) observations[0].effective.source = "server";
  },
  description: (observations, vector) => {
    if (vector.rfcVector === 9) observations[2].model.description += " ";
  },
  schema: (observations, vector) => {
    if (vector.rfcVector === 9) observations[3].model.inputSchema.additionalProperties = true;
  },
  sent: (observations, vector) => {
    if (vector.rfcVector !== 5) return;
    delete observations[2].opening.inputWithheld;
    observations[2].opening.input = structuredClone(vector.input);
  },
  withheld: (observations, vector) => {
    if (vector.rfcVector !== 1) return;
    delete observations[0].opening.input;
    observations[0].opening.inputWithheld = true;
  },
  suppressed: (observations, vector) => {
    if (vector.rfcVector === 2) observations[0].opening = null;
  },
  unprojected: (observations, vector) => {
    if (vector.rfcVector === 7) delete observations[0].model;
  },
  dropped: (observations, vector) => {
    if (vector.rfcVector === 8) observations.pop();
  },
};

export async function loadHost(fault) {
  if (!Object.hasOwn(FAULTS, fault) && fault !== "none") throw Error("Unknown stand-in fault: " + fault);
  return {
    info: { implementation: "stand-in", revision: "none", fault },
    async observe(vector) {
      const observations = vector.stages.map(stage => {
        const classes = stage.expect.classes;
        const sent = stage.expect.input === "sent";
        return {
          descriptor: { class: [...classes] },
          effective: { classes: [...classes], source: stage.expect.source },
          model: { name: stage.modelName, description: stage.tool.description, inputSchema: structuredClone(stage.tool.inputSchema) },
          opening: { phase: "started", class: [...classes], ...(sent ? { input: structuredClone(vector.input) } : { inputWithheld: true }) },
          diagnostics: [],
        };
      });
      FAULTS[fault]?.(observations, vector);
      return observations;
    },
  };
}
