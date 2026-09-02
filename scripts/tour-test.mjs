import assert from "node:assert/strict";

import {
  createTour,
  placeTooltip,
  tourPlacements,
  tourSeenValue,
  tourSteps,
  tourStorageKey,
} from "../web/tour.mjs";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    data,
  };
}

function throwingStorage() {
  const fail = () => {
    throw new Error("storage unavailable");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

// Step definitions are complete, unique, and anchored.
{
  assert.ok(tourSteps.length >= 5);
  const ids = new Set();
  for (const step of tourSteps) {
    assert.ok(step.id && !ids.has(step.id), `duplicate or missing step id: ${step.id}`);
    ids.add(step.id);
    assert.ok(step.target.length > 0, `step ${step.id} has no target`);
    assert.ok(step.title.length > 0, `step ${step.id} has no title`);
    assert.ok(step.body.length > 0, `step ${step.id} has no body`);
    assert.ok(tourPlacements.includes(step.placement), `step ${step.id} has an unknown placement`);
  }
  assert.equal(tourSteps[0].id, "editor");
  assert.equal(tourSteps[tourSteps.length - 1].id, "help");
}

// A fresh browser auto-starts the tour; starting records it as seen.
{
  const storage = memoryStorage();
  const tour = createTour({ storage });
  assert.equal(tour.active, false);
  assert.equal(tour.step, null);
  assert.equal(tour.progress, "");
  assert.equal(tour.seen(), false);
  assert.equal(tour.shouldAutoStart(), true);

  const first = tour.start();
  assert.equal(first, tourSteps[0]);
  assert.equal(tour.active, true);
  assert.equal(tour.index, 0);
  assert.equal(tour.isFirst, true);
  assert.equal(tour.isLast, false);
  assert.equal(tour.progress, `1 of ${tourSteps.length}`);
  assert.equal(storage.getItem(tourStorageKey), tourSeenValue);
  assert.equal(tour.seen(), true);
  assert.equal(tour.shouldAutoStart(), false);
}

// Stepping is bounded at both ends and finishing the last step ends the tour.
{
  const tour = createTour({ storage: memoryStorage() });
  tour.start();
  assert.equal(tour.back(), tourSteps[0]);
  assert.equal(tour.index, 0);

  for (let expected = 1; expected < tourSteps.length; expected += 1) {
    assert.equal(tour.next(), tourSteps[expected]);
    assert.equal(tour.index, expected);
  }
  assert.equal(tour.isLast, true);
  assert.equal(tour.next(), null);
  assert.equal(tour.active, false);
  assert.equal(tour.next(), null);

  tour.start(tourSteps.length - 1);
  assert.equal(tour.isLast, true);
  assert.equal(tour.back(), tourSteps[tourSteps.length - 2]);

  tour.start(999);
  assert.equal(tour.index, tourSteps.length - 1);
  tour.start(-5);
  assert.equal(tour.index, 0);
  tour.start("not a number");
  assert.equal(tour.index, 0);
}

// Finishing early still marks the tour as seen and resetting forgets it.
{
  const storage = memoryStorage();
  const tour = createTour({ storage });
  tour.start();
  tour.next();
  assert.equal(tour.finish(), true);
  assert.equal(tour.active, false);
  assert.equal(tour.step, null);
  assert.equal(tour.seen(), true);
  assert.equal(tour.reset(), true);
  assert.equal(storage.getItem(tourStorageKey), null);
  assert.equal(tour.seen(), false);
  assert.equal(tour.shouldAutoStart(), true);
}

// A previous visit recorded in storage suppresses the automatic start.
{
  const storage = memoryStorage();
  storage.setItem(tourStorageKey, tourSeenValue);
  const tour = createTour({ storage });
  assert.equal(tour.shouldAutoStart(), false);
  storage.setItem(tourStorageKey, "something-else");
  assert.equal(createTour({ storage }).shouldAutoStart(), true);
}

// Unavailable storage falls back to remembering the visit for the current tab.
{
  const tour = createTour({ storage: throwingStorage() });
  assert.equal(tour.shouldAutoStart(), true);
  assert.equal(tour.markSeen(), false);
  assert.equal(tour.seen(), true);
  assert.equal(tour.shouldAutoStart(), false);
  assert.equal(tour.reset(), false);
  assert.equal(tour.shouldAutoStart(), true);
  assert.doesNotThrow(() => tour.start());
  assert.equal(tour.active, true);
}

// The tour works without any storage and rejects empty step lists.
{
  const tour = createTour();
  assert.equal(tour.shouldAutoStart(), true);
  tour.start();
  assert.equal(tour.shouldAutoStart(), false);
  assert.throws(() => createTour({ steps: [] }), /at least one step/);
}

// Tooltips sit below their target and clamp within the viewport.
{
  const viewport = { width: 1200, height: 800 };
  const tooltip = { width: 320, height: 140 };
  const below = placeTooltip({
    target: { left: 100, top: 100, right: 300, bottom: 140 },
    tooltip,
    viewport,
    placement: "bottom",
  });
  assert.deepEqual(below, { left: 100, top: 152, placement: "bottom" });

  const flipped = placeTooltip({
    target: { left: 100, top: 700, right: 300, bottom: 760 },
    tooltip,
    viewport,
    placement: "bottom",
  });
  assert.deepEqual(flipped, { left: 100, top: 548, placement: "top" });

  const clampedRight = placeTooltip({
    target: { left: 1100, top: 100, right: 1190, bottom: 140 },
    tooltip,
    viewport,
    placement: "bottom",
  });
  assert.equal(clampedRight.left, viewport.width - tooltip.width - 12);

  const clampedLeft = placeTooltip({
    target: { left: -40, top: 100, right: 20, bottom: 140 },
    tooltip,
    viewport,
    placement: "bottom",
  });
  assert.equal(clampedLeft.left, 12);

  const unknownPlacement = placeTooltip({
    target: { left: 100, top: 100, right: 300, bottom: 140 },
    tooltip,
    viewport,
    placement: "sideways",
  });
  assert.equal(unknownPlacement.placement, "bottom");

  const topPreferred = placeTooltip({
    target: { left: 100, top: 20, right: 300, bottom: 60 },
    tooltip,
    viewport,
    placement: "top",
  });
  assert.equal(topPreferred.placement, "bottom");
  assert.equal(topPreferred.top, 72);

  const cramped = placeTooltip({
    target: { left: 0, top: 0, right: 200, bottom: 200 },
    tooltip: { width: 400, height: 400 },
    viewport: { width: 300, height: 300 },
    placement: "bottom",
  });
  assert.equal(cramped.left, 12);
  assert.equal(cramped.top, 12);
  assert.equal(cramped.placement, "bottom");
}

console.log("tour tests passed");
