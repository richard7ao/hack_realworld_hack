import type { Environment } from "../contract";

/** The catalogue on the drop screen. Served by GET /environments; the backend may replace it. */
export const ENVIRONMENTS: Environment[] = [
  {
    id: "kitchen-counter",
    name: "Kitchen Counter",
    blurb: "Domestic clutter, reflective surfaces and a tight pour zone.",
    objects: ["mug", "tray", "kettle", "sponge"],
    difficulty: "medium",
    tasks: ["Pick up the red mug and place it on the tray", "Move the sponge into the sink caddy", "Set the kettle back on its base"],
  },
  {
    id: "warehouse-shelf",
    name: "Warehouse Shelf",
    blurb: "Deep bins, occlusion from neighbouring stock, low overhead light.",
    objects: ["tote", "carton", "label", "divider"],
    difficulty: "hard",
    tasks: ["Pick the labelled carton from the middle bin", "Transfer the tote to the outbound chute", "Reorient the carton so the label faces out"],
  },
  {
    id: "lab-bench",
    name: "Lab Bench",
    blurb: "Rigid fixtures, high contrast, millimetre placement tolerance.",
    objects: ["pipette", "rack", "beaker", "tip box"],
    difficulty: "easy",
    tasks: ["Place the pipette back in the rack", "Move the beaker to the weighing station", "Load a fresh tip from the tip box"],
  },
  {
    id: "cluttered-desk",
    name: "Cluttered Desk",
    blurb: "Dense distractors, cable tangles and ambiguous grasp affordances.",
    objects: ["stapler", "mug", "cables", "notebook"],
    difficulty: "hard",
    tasks: ["Clear the mug into the tray", "Pick up the stapler without snagging the cables", "Stack the notebook on the left pile"],
  },
];

export const environmentById = (id: string): Environment | undefined => ENVIRONMENTS.find((e) => e.id === id);
