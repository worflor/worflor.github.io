/**
 * 404 Game of Life - Comprehensive Test Suite
 *
 * Tests every major, core, and minor system to ensure the game works correctly.
 * Run in browser console on the 404 page.
 *
 * Usage:
 *   run404Tests()           - Run all tests
 *   run404Tests('creature') - Run only creature tests
 *   test404.runAll()        - Alias for run all
 */

(function() {
  'use strict';

  const tests = [];
  let passed = 0;
  let failed = 0;

  // ===========================================
  // TEST UTILITIES
  // ===========================================

  function test(category, name, fn) {
    tests.push({ category, name, fn });
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
  }

  function assertRange(value, min, max, message) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(message || `Value ${value} is not a finite number`);
    }
    if (value < min || value > max) {
      throw new Error(message || `Value ${value} not in range [${min}, ${max}]`);
    }
  }

  function assertType(value, type, message) {
    if (typeof value !== type) {
      throw new Error(message || `Expected type ${type}, got ${typeof value}`);
    }
  }

  function assertExists(value, message) {
    if (value === undefined || value === null) {
      throw new Error(message || 'Value is undefined or null');
    }
  }

  function assertArray(value, message) {
    if (!Array.isArray(value)) {
      throw new Error(message || `Expected array, got ${typeof value}`);
    }
  }

  function skip(reason) {
    throw { skip: true, reason };
  }

  function requireGlobals(...names) {
    for (const name of names) {
      if (typeof window[name] === 'undefined') {
        skip(`Global '${name}' not available`);
      }
    }
  }

  function requireCreatures(min = 1) {
    requireGlobals('creatures');
    if (creatures.length < min) skip(`Need at least ${min} creature(s)`);
  }

  // ===========================================
  // CONFIG VALIDATION
  // ===========================================

  test('config', 'CONFIG exists with required constants', () => {
    requireGlobals('CONFIG');
    const required = [
      'MAX_FOODS', 'MAX_PARTICLES', 'MAX_EMOTES', 'MAX_CREATURES',
      'BASE_ENERGY_DRAIN', 'PICKUP_HOLD_TIME', 'FOOD_DROP_INTERVAL',
      'REVEAL_RES', 'REVEAL_DECAY', 'HOLE_SPAWN_CHANCE', 'MIN_HOLE_DIST',
      'MIN_REPRODUCE_AGE', 'REPRODUCE_CHANCE', 'REPRODUCE_ENERGY_COST',
      'BABY_AGE', 'CHILD_AGE', 'ADULT_AGE', 'ELDER_AGE', 'MAX_AGE',
      'COMFORT_RADIUS', 'SOCIAL_RADIUS', 'FRIEND_RADIUS', 'FOOD_SEEK_RADIUS',
      'SAVE_INTERVAL', 'RESPAWN_DELAY'
    ];
    for (const key of required) {
      assertExists(CONFIG[key], `CONFIG.${key} missing`);
      assertType(CONFIG[key], 'number', `CONFIG.${key} should be number`);
      assert(CONFIG[key] >= 0, `CONFIG.${key} should be non-negative`);
    }
  });

  test('config', 'Life stage ages are sequential', () => {
    requireGlobals('CONFIG');
    assert(CONFIG.BABY_AGE < CONFIG.CHILD_AGE, 'BABY_AGE < CHILD_AGE');
    assert(CONFIG.CHILD_AGE < CONFIG.ADULT_AGE, 'CHILD_AGE < ADULT_AGE');
    assert(CONFIG.ADULT_AGE < CONFIG.ELDER_AGE, 'ADULT_AGE < ELDER_AGE');
    assert(CONFIG.ELDER_AGE < CONFIG.MAX_AGE, 'ELDER_AGE < MAX_AGE');
  });

  test('config', 'Array limits are positive integers', () => {
    requireGlobals('CONFIG');
    assert(Number.isInteger(CONFIG.MAX_FOODS) && CONFIG.MAX_FOODS > 0, 'MAX_FOODS');
    assert(Number.isInteger(CONFIG.MAX_PARTICLES) && CONFIG.MAX_PARTICLES > 0, 'MAX_PARTICLES');
    assert(Number.isInteger(CONFIG.MAX_EMOTES) && CONFIG.MAX_EMOTES > 0, 'MAX_EMOTES');
    assert(Number.isInteger(CONFIG.MAX_CREATURES) && CONFIG.MAX_CREATURES > 0, 'MAX_CREATURES');
  });

  // ===========================================
  // CREATURE CLASS STRUCTURE
  // ===========================================

  test('creature', 'Creatures have required identity properties', () => {
    requireCreatures();
    for (const c of creatures) {
      assertType(c.id, 'string', `${c.name || 'creature'}.id`);
      assert(c.id.length > 0, 'id not empty');
      assertType(c.name, 'string', `${c.id}.name`);
      assert(c.name.length > 0, 'name not empty');
      assertType(c.generation, 'number', `${c.name}.generation`);
      assert(c.generation >= 0, 'generation >= 0');
    }
  });

  test('creature', 'Creatures have valid personality (OCEAN)', () => {
    requireCreatures();
    const traits = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'stability'];
    for (const c of creatures) {
      for (const trait of traits) {
        assertRange(c[trait], 0, 1, `${c.name}.${trait}`);
      }
    }
  });

  test('creature', 'Creatures have valid appearance genetics', () => {
    requireCreatures();
    for (const c of creatures) {
      assertRange(c.hue, 0, 360, `${c.name}.hue`);
      assertRange(c.roundness, 0, 1.5, `${c.name}.roundness`);
      assertRange(c.glow, 0.5, 2, `${c.name}.glow`);
      assertRange(c.size, 0, 1.5, `${c.name}.size`);
      assertRange(c.targetSize, 0.5, 1.5, `${c.name}.targetSize`);
      assertRange(c.animSpeed, 0.5, 1.5, `${c.name}.animSpeed`);
    }
  });

  test('creature', 'Creatures have valid energy and needs', () => {
    requireCreatures();
    for (const c of creatures) {
      assertRange(c.energy, 0, 100, `${c.name}.energy`);
      assertRange(c.happiness, 0, 100, `${c.name}.happiness`);
      assertRange(c.fatigue, 0, 1, `${c.name}.fatigue`);
      assertRange(c.restedness, 0, 1, `${c.name}.restedness`);
      assertRange(c.comforted, 0, 1, `${c.name}.comforted`);
      assertRange(c.lonely, 0, 1, `${c.name}.lonely`);
      assertRange(c.petted, 0, 1, `${c.name}.petted`);
    }
  });

  test('creature', 'Creatures have valid fear and trust', () => {
    requireCreatures();
    for (const c of creatures) {
      assertRange(c.fear, 0, 1, `${c.name}.fear`);
      assertRange(c.stress, 0, 1, `${c.name}.stress`);
      assertRange(c.trust, 0, 1, `${c.name}.trust`);
      assertRange(c.attachment, 0, 1, `${c.name}.attachment`);
      assertRange(c.anticipation, 0, 1, `${c.name}.anticipation`);
    }
  });

  test('creature', 'Creatures have valid position and velocity', () => {
    requireCreatures();
    requireGlobals('W', 'H');
    for (const c of creatures) {
      assert(Number.isFinite(c.x), `${c.name}.x is finite`);
      assert(Number.isFinite(c.y), `${c.name}.y is finite`);
      assert(Number.isFinite(c.vx), `${c.name}.vx is finite`);
      assert(Number.isFinite(c.vy), `${c.name}.vy is finite`);
      // Allow margin outside screen
      assertRange(c.x, -100, W + 100, `${c.name}.x within bounds`);
      assertRange(c.y, -100, H + 100, `${c.name}.y within bounds`);
    }
  });

  test('creature', 'Creature velocities within reasonable limits', () => {
    requireCreatures();
    for (const c of creatures) {
      const speed = Math.hypot(c.vx, c.vy);
      assert(speed < 15, `${c.name} speed ${speed.toFixed(2)} < 15`);
    }
  });

  test('creature', 'Creatures have valid deformation state', () => {
    requireCreatures();
    for (const c of creatures) {
      assertRange(c.squash, 0.5, 1.5, `${c.name}.squash`);
      assert(Number.isFinite(c.squashVel), `${c.name}.squashVel finite`);
      assert(Number.isFinite(c.bodyLagX), `${c.name}.bodyLagX finite`);
      assert(Number.isFinite(c.bodyLagY), `${c.name}.bodyLagY finite`);
    }
  });

  test('creature', 'Creatures have valid age', () => {
    requireCreatures();
    for (const c of creatures) {
      assert(Number.isInteger(c.age), `${c.name}.age is integer`);
      assert(c.age >= 0, `${c.name}.age >= 0`);
    }
  });

  test('creature', 'isDead is boolean and consistent', () => {
    requireCreatures();
    for (const c of creatures) {
      assertType(c.isDead, 'boolean', `${c.name}.isDead`);
      // Live creatures in array should not be dead
      assert(!c.isDead, `Dead creature ${c.name} should not be in creatures array`);
    }
  });

  test('creature', 'Creature IDs are unique', () => {
    requireCreatures();
    const ids = new Set();
    for (const c of creatures) {
      assert(!ids.has(c.id), `Duplicate creature ID: ${c.id}`);
      ids.add(c.id);
    }
  });

  // ===========================================
  // SOCIAL & BONDING SYSTEM
  // ===========================================

  test('social', 'Bonds reference existing creatures', () => {
    requireCreatures();
    const creatureIds = new Set(creatures.map(c => c.id));
    for (const c of creatures) {
      assert(c.bonds instanceof Map, `${c.name}.bonds is Map`);
      for (const bondId of c.bonds.keys()) {
        assert(creatureIds.has(bondId), `${c.name} bond ${bondId} exists`);
      }
    }
  });

  test('social', 'Bond data has valid structure', () => {
    requireCreatures();
    for (const c of creatures) {
      for (const [id, bond] of c.bonds) {
        assertRange(bond.strength, 0, 1, `${c.name} bond to ${id} strength`);
        assert(bond.sharedTime >= 0, `${c.name} bond sharedTime >= 0`);
        assert(bond.sharedMeals >= 0, `${c.name} bond sharedMeals >= 0`);
      }
    }
  });

  test('social', 'Friends reference existing creatures', () => {
    requireCreatures();
    const creatureIds = new Set(creatures.map(c => c.id));
    for (const c of creatures) {
      assert(c.friends instanceof Set, `${c.name}.friends is Set`);
      for (const friendId of c.friends) {
        assert(creatureIds.has(friendId), `${c.name} friend ${friendId} exists`);
      }
    }
  });

  test('social', 'Friends are subset of bonds', () => {
    requireCreatures();
    for (const c of creatures) {
      for (const friendId of c.friends) {
        assert(c.bonds.has(friendId), `${c.name} friend ${friendId} has bond`);
      }
    }
  });

  test('social', 'Parent references are valid or null', () => {
    requireCreatures();
    const creatureIds = new Set(creatures.map(c => c.id));
    for (const c of creatures) {
      if (c.parentId !== null && c.parentId !== undefined) {
        // Parent may have died, so we just check it's a string
        assertType(c.parentId, 'string', `${c.name}.parentId type`);
      }
    }
  });

  test('social', 'Social context neediest is valid', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c.socialContext && c.socialContext.neediest) {
        assert(!c.socialContext.neediest.isDead, `${c.name} socialContext.neediest not dead`);
        assert(creatures.includes(c.socialContext.neediest), `${c.name} neediest in array`);
      }
    }
  });

  test('social', '_nearbyCreatures excludes dead', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c._nearbyCreatures && Array.isArray(c._nearbyCreatures)) {
        for (const entry of c._nearbyCreatures) {
          assert(!entry.creature.isDead, `${c.name} _nearbyCreatures has dead creature`);
        }
      }
    }
  });

  // ===========================================
  // MEMORY SYSTEM
  // ===========================================

  test('memory', 'Memory structure is valid', () => {
    requireCreatures();
    for (const c of creatures) {
      assertExists(c.memories, `${c.name}.memories`);
      assertArray(c.memories.goodSpots, `${c.name}.memories.goodSpots`);
      assertArray(c.memories.badSpots, `${c.name}.memories.badSpots`);
      assert(c.memories.fedCount >= 0, `${c.name}.memories.fedCount >= 0`);
      assert(c.memories.petCount >= 0, `${c.name}.memories.petCount >= 0`);
    }
  });

  test('memory', 'Memory spots have valid data', () => {
    requireCreatures();
    for (const c of creatures) {
      for (const spot of c.memories.goodSpots) {
        assert(Number.isFinite(spot.x), `${c.name} goodSpot.x`);
        assert(Number.isFinite(spot.y), `${c.name} goodSpot.y`);
        assertRange(spot.strength, 0, 2, `${c.name} goodSpot.strength`);
      }
      for (const spot of c.memories.badSpots) {
        assert(Number.isFinite(spot.x), `${c.name} badSpot.x`);
        assert(Number.isFinite(spot.y), `${c.name} badSpot.y`);
        assertRange(spot.strength, 0, 2, `${c.name} badSpot.strength`);
      }
    }
  });

  test('memory', 'Home position is valid when set', () => {
    requireCreatures();
    requireGlobals('W', 'H');
    for (const c of creatures) {
      if (c.homeStrength > 0) {
        assert(Number.isFinite(c.homeX), `${c.name}.homeX finite`);
        assert(Number.isFinite(c.homeY), `${c.name}.homeY finite`);
        assertRange(c.homeX, -50, W + 50, `${c.name}.homeX in bounds`);
        assertRange(c.homeY, -50, H + 50, `${c.name}.homeY in bounds`);
      }
      assertRange(c.homeStrength, 0, 1, `${c.name}.homeStrength`);
    }
  });

  // ===========================================
  // FOOD SYSTEM
  // ===========================================

  test('food', 'Foods array within limit', () => {
    requireGlobals('foods', 'CONFIG');
    assertArray(foods, 'foods is array');
    assert(foods.length <= CONFIG.MAX_FOODS, `foods.length ${foods.length} <= ${CONFIG.MAX_FOODS}`);
  });

  test('food', 'Foods have valid properties', () => {
    requireGlobals('foods', 'W', 'H');
    for (const f of foods) {
      assert(Number.isFinite(f.x), 'food.x finite');
      assert(Number.isFinite(f.y), 'food.y finite');
      assertRange(f.x, -50, W + 50, 'food.x in bounds');
      assertRange(f.y, -50, H + 50, 'food.y in bounds');
      assert(Number.isFinite(f.vy), 'food.vy finite');
      assertRange(f.life, 0, 1.1, 'food.life');
      assertRange(f.size, 0.5, 6, 'food.size');
      assert(['white', 'green', 'cyan', 'purple'].includes(f.type), `food.type valid: ${f.type}`);
    }
  });

  test('food', 'Food claims bidirectionally consistent', () => {
    requireGlobals('foods', 'creatures');
    // Check food→creature references
    for (const f of foods) {
      if (f.claimedBy) {
        assert(!f.claimedBy.isDead, 'Food claimed by dead creature');
        assert(creatures.includes(f.claimedBy), 'Food claimedBy in creatures array');
        assertEqual(f.claimedBy._claimedFood, f, 'Bidirectional claim mismatch');
      }
    }
    // Check creature→food references
    for (const c of creatures) {
      if (c._claimedFood) {
        assert(foods.includes(c._claimedFood), `${c.name} claims food in foods array`);
        assert(c._claimedFood.life > 0, `${c.name} claims living food`);
        assertEqual(c._claimedFood.claimedBy, c, 'Bidirectional claim mismatch');
      }
    }
  });

  // ===========================================
  // PARTICLE SYSTEM
  // ===========================================

  test('particle', 'Particles array within limit', () => {
    requireGlobals('particles', 'CONFIG');
    assertArray(particles, 'particles is array');
    assert(particles.length <= CONFIG.MAX_PARTICLES, `particles ${particles.length} <= ${CONFIG.MAX_PARTICLES}`);
  });

  test('particle', 'Particles have valid properties', () => {
    requireGlobals('particles');
    for (const p of particles) {
      assert(Number.isFinite(p.x), 'particle.x finite');
      assert(Number.isFinite(p.y), 'particle.y finite');
      assert(Number.isFinite(p.vx), 'particle.vx finite');
      assert(Number.isFinite(p.vy), 'particle.vy finite');
      assertRange(p.life, 0, 1.1, 'particle.life');
      assert(p.size > 0, 'particle.size > 0');
    }
  });

  // ===========================================
  // EMOTE SYSTEM
  // ===========================================

  test('emote', 'Emotes array within limit', () => {
    requireGlobals('emotes', 'CONFIG');
    assertArray(emotes, 'emotes is array');
    assert(emotes.length <= CONFIG.MAX_EMOTES, `emotes ${emotes.length} <= ${CONFIG.MAX_EMOTES}`);
  });

  test('emote', 'Emotes have valid properties', () => {
    requireGlobals('emotes', 'EMOTE_STYLES');
    for (const e of emotes) {
      assert(Number.isFinite(e.x), 'emote.x finite');
      assert(Number.isFinite(e.y), 'emote.y finite');
      assertRange(e.life, 0, 1.1, 'emote.life');
      assertType(e.symbol, 'string', 'emote.symbol');
      assertType(e.color, 'string', 'emote.color');
    }
  });

  // ===========================================
  // HOLES SYSTEM
  // ===========================================

  test('hole', 'Holes have valid properties', () => {
    requireGlobals('holes', 'W', 'H');
    assertArray(holes, 'holes is array');
    for (const h of holes) {
      assert(Number.isFinite(h.x), 'hole.x finite');
      assert(Number.isFinite(h.y), 'hole.y finite');
      assertRange(h.x, -50, W + 50, 'hole.x in bounds');
      assertRange(h.y, -50, H + 50, 'hole.y in bounds');
      assert(h.radius > 0, 'hole.radius > 0');
      assertRange(h.revealLevel, 0, 1, 'hole.revealLevel');
    }
  });

  test('hole', 'Holes maintain minimum distance', () => {
    requireGlobals('holes', 'CONFIG');
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        const dx = holes[i].x - holes[j].x;
        const dy = holes[i].y - holes[j].y;
        const dist = Math.hypot(dx, dy);
        // Allow 80% of min dist for edge cases
        assert(dist >= CONFIG.MIN_HOLE_DIST * 0.8, `Holes ${i},${j} too close: ${dist.toFixed(0)}`);
      }
    }
  });

  // ===========================================
  // FISSURE SYSTEM
  // ===========================================

  test('fissure', 'Fissures have valid structure', () => {
    requireGlobals('fissures');
    assertArray(fissures, 'fissures is array');
    for (const f of fissures) {
      assertArray(f.points, 'fissure.points');
      assert(f.points.length >= 2, 'fissure has >= 2 points');
      for (const p of f.points) {
        assert(Number.isFinite(p.x), 'fissure point.x finite');
        assert(Number.isFinite(p.y), 'fissure point.y finite');
      }
    }
  });

  // ===========================================
  // STRUCTURE SYSTEMS (MONOLITHS, NESTS)
  // ===========================================

  test('structure', 'Monoliths have valid properties', () => {
    requireGlobals('monoliths', 'W', 'H');
    assertArray(monoliths, 'monoliths is array');
    for (const m of monoliths) {
      assert(Number.isFinite(m.x), 'monolith.x finite');
      assert(Number.isFinite(m.y), 'monolith.y finite');
      assertRange(m.x, -50, W + 50, 'monolith.x bounds');
      assertRange(m.y, -50, H + 50, 'monolith.y bounds');
      assertRange(m.presence, 0, 1, 'monolith.presence');
    }
  });

  test('structure', 'Nests have valid properties', () => {
    requireGlobals('nests', 'W', 'H');
    assertArray(nests, 'nests is array');
    for (const n of nests) {
      assert(Number.isFinite(n.x), 'nest.x finite');
      assert(Number.isFinite(n.y), 'nest.y finite');
      assertRange(n.x, -50, W + 50, 'nest.x bounds');
      assertRange(n.y, -50, H + 50, 'nest.y bounds');
      assert(n.radius > 0, 'nest.radius > 0');
    }
  });

  // ===========================================
  // FOG/REVEAL SYSTEM
  // ===========================================

  test('fog', 'Reveal map exists and has correct dimensions', () => {
    requireGlobals('revealMap', 'revealW', 'revealH', 'CONFIG');
    assert(revealMap instanceof Float32Array, 'revealMap is Float32Array');
    assertEqual(revealMap.length, revealW * revealH, 'revealMap length matches dimensions');
    assert(revealW > 0 && revealH > 0, 'reveal dimensions positive');
  });

  test('fog', 'Reveal map values in valid range', () => {
    requireGlobals('revealMap');
    let outOfRange = 0;
    for (let i = 0; i < revealMap.length; i++) {
      if (revealMap[i] < -0.1 || revealMap[i] > 1.1) outOfRange++;
    }
    assert(outOfRange === 0, `${outOfRange} reveal cells out of range`);
  });

  test('fog', 'Fog canvas exists', () => {
    requireGlobals('fogCanvas', 'fogCtx');
    assert(fogCanvas instanceof HTMLCanvasElement || fogCanvas instanceof OffscreenCanvas, 'fogCanvas is canvas');
    assert(fogCtx !== null, 'fogCtx exists');
  });

  // ===========================================
  // INPUT STATE
  // ===========================================

  test('input', 'Mouse state is valid', () => {
    requireGlobals('mouse');
    assertType(mouse.down, 'boolean', 'mouse.down');
    assertType(mouse.rightDown, 'boolean', 'mouse.rightDown');
    assert(Number.isFinite(mouse.x), 'mouse.x finite');
    assert(Number.isFinite(mouse.y), 'mouse.y finite');
    assert(Number.isFinite(mouse.holdTime), 'mouse.holdTime finite');
    assert(Number.isFinite(mouse.rightHoldTime), 'mouse.rightHoldTime finite');
    assert(mouse.holdTime >= 0, 'mouse.holdTime >= 0');
    assert(mouse.rightHoldTime >= 0, 'mouse.rightHoldTime >= 0');
  });

  test('input', 'Held creature is valid when set', () => {
    requireGlobals('heldCreature', 'creatures');
    if (heldCreature !== null) {
      assert(!heldCreature.isDead, 'heldCreature not dead');
      assert(creatures.includes(heldCreature), 'heldCreature in array');
    }
  });

  test('input', 'Tooltip creature is valid when set', () => {
    requireGlobals('tooltipCreature', 'creatures');
    if (tooltipCreature !== null && tooltipCreature !== undefined) {
      assert(creatures.includes(tooltipCreature) || tooltipCreature.isDead, 'tooltipCreature valid or dead');
    }
  });

  // ===========================================
  // WORLD STATE
  // ===========================================

  test('world', 'Canvas dimensions are valid', () => {
    requireGlobals('W', 'H');
    assert(W > 0 && Number.isFinite(W), 'W > 0');
    assert(H > 0 && Number.isFinite(H), 'H > 0');
  });

  test('world', 'Current depth is valid', () => {
    requireGlobals('currentDepth');
    assert(Number.isInteger(currentDepth), 'currentDepth is integer');
    assert(currentDepth >= 0, 'currentDepth >= 0');
  });

  test('world', 'Time counter is valid', () => {
    requireGlobals('time');
    assert(Number.isInteger(time), 'time is integer');
    assert(time >= 0, 'time >= 0');
  });

  test('world', 'Creatures array within limit', () => {
    requireGlobals('creatures', 'CONFIG');
    assert(creatures.length <= CONFIG.MAX_CREATURES, `creatures ${creatures.length} <= ${CONFIG.MAX_CREATURES}`);
  });

  // ===========================================
  // COMPUTED PROPERTIES
  // ===========================================

  test('computed', 'Creature displaySize is reasonable', () => {
    requireCreatures();
    for (const c of creatures) {
      const displaySize = c.displaySize;
      assertRange(displaySize, 3, 30, `${c.name}.displaySize`);
    }
  });

  test('computed', 'Creature lifeStage is valid', () => {
    requireCreatures();
    const validStages = ['baby', 'child', 'adult', 'elder'];
    for (const c of creatures) {
      assert(validStages.includes(c.lifeStage), `${c.name}.lifeStage valid: ${c.lifeStage}`);
    }
  });

  test('computed', 'Creature revealRadius is positive', () => {
    requireCreatures();
    for (const c of creatures) {
      assert(c.revealRadius > 0, `${c.name}.revealRadius > 0`);
      assert(Number.isFinite(c.revealRadius), `${c.name}.revealRadius finite`);
    }
  });

  test('computed', 'Creature emissionRgb is valid', () => {
    requireCreatures();
    for (const c of creatures) {
      assertArray(c.emissionRgb, `${c.name}.emissionRgb`);
      assertEqual(c.emissionRgb.length, 3, `${c.name}.emissionRgb has 3 values`);
      for (let i = 0; i < 3; i++) {
        assertRange(c.emissionRgb[i], 0, 255, `${c.name}.emissionRgb[${i}]`);
      }
    }
  });

  // ===========================================
  // EXPRESSION SYSTEM
  // ===========================================

  test('expression', 'Creature expressions are valid', () => {
    requireCreatures();
    const validExpressions = ['neutral', 'happy', 'scared', 'sad', 'loved', 'nervous', 'sleepy', 'surprised', 'eating'];
    for (const c of creatures) {
      assert(validExpressions.includes(c.expression), `${c.name}.expression valid: ${c.expression}`);
      assert(c.expressionTimer >= 0, `${c.name}.expressionTimer >= 0`);
    }
  });

  test('expression', 'Sleeping creatures have sleepy expression or are waking', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c.sleeping) {
        // Sleeping can briefly have non-sleepy expression during wake transition
        assert(c.expression === 'sleepy' || c.expressionTimer > 0, `${c.name} sleeping expression`);
      }
    }
  });

  // ===========================================
  // GAZE SYSTEM
  // ===========================================

  test('gaze', 'Creature gaze is bounded', () => {
    requireCreatures();
    for (const c of creatures) {
      assertRange(c.gazeX, -3, 3, `${c.name}.gazeX`);
      assertRange(c.gazeY, -3, 3, `${c.name}.gazeY`);
      assert(c.gazeTimer >= 0, `${c.name}.gazeTimer >= 0`);
    }
  });

  // ===========================================
  // SPECIAL STATE
  // ===========================================

  test('special', 'Void chorus timer is valid', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c._voidChorusTimer !== undefined) {
        assert(c._voidChorusTimer >= 0, `${c.name}._voidChorusTimer >= 0`);
        assertRange(c._voidChorusStrength, 0, 1, `${c.name}._voidChorusStrength`);
      }
    }
  });

  test('special', 'Cached light level is valid when set', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c._cachedLightLevel !== undefined) {
        assertRange(c._cachedLightLevel, 0, 1.5, `${c.name}._cachedLightLevel`);
      }
    }
  });

  // ===========================================
  // GLOBAL FUNCTIONS EXIST
  // ===========================================

  test('functions', 'Core game functions exist', () => {
    requireGlobals('update', 'draw', 'gameLoop');
    assertType(update, 'function', 'update');
    assertType(draw, 'function', 'draw');
    assertType(gameLoop, 'function', 'gameLoop');
  });

  test('functions', 'Save/load functions exist', () => {
    requireGlobals('save', 'load', 'reset');
    assertType(save, 'function', 'save');
    assertType(load, 'function', 'load');
    assertType(reset, 'function', 'reset');
  });

  test('functions', 'Utility functions exist', () => {
    requireGlobals('generateName', 'formatAge', 'dist', 'distSq');
    assertType(generateName, 'function', 'generateName');
    assertType(formatAge, 'function', 'formatAge');
    assertType(dist, 'function', 'dist');
    assertType(distSq, 'function', 'distSq');
  });

  // ===========================================
  // INVARIANTS
  // ===========================================

  test('invariant', 'No creature has both sleeping and high fear', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c.sleeping) {
        // Wake threshold is fear > 0.5
        assert(c.fear <= 0.6, `${c.name} sleeping with fear ${c.fear.toFixed(2)}`);
      }
    }
  });

  test('invariant', 'Babies are younger than CHILD_AGE', () => {
    requireCreatures();
    requireGlobals('CONFIG');
    for (const c of creatures) {
      if (c.lifeStage === 'baby') {
        assert(c.age < CONFIG.CHILD_AGE, `Baby ${c.name} age ${c.age} < CHILD_AGE`);
      }
    }
  });

  test('invariant', 'Elders are older than ELDER_AGE', () => {
    requireCreatures();
    requireGlobals('CONFIG');
    for (const c of creatures) {
      if (c.lifeStage === 'elder') {
        assert(c.age >= CONFIG.ELDER_AGE, `Elder ${c.name} age ${c.age} >= ELDER_AGE`);
      }
    }
  });

  test('invariant', 'Higher generation creatures have parents or are immigrants', () => {
    requireCreatures();
    for (const c of creatures) {
      if (c.generation > 0) {
        // Either has parentId set, or is loaded save data / edge case
        assert(c.parentId !== undefined, `Gen ${c.generation} ${c.name} has parentId defined`);
      }
    }
  });

  // ===========================================
  // TEST RUNNER
  // ===========================================

  function runAllTests(categoryFilter = null) {
    passed = 0;
    failed = 0;
    let skipped = 0;

    const filteredTests = categoryFilter
      ? tests.filter(t => t.category.toLowerCase().includes(categoryFilter.toLowerCase()))
      : tests;

    console.log('%c=== 404 Game Comprehensive Test Suite ===', 'font-weight: bold; font-size: 14px;');
    console.log(`Running ${filteredTests.length} tests${categoryFilter ? ` (filter: ${categoryFilter})` : ''}...\n`);

    const categories = {};
    for (const t of filteredTests) {
      if (!categories[t.category]) categories[t.category] = [];
      categories[t.category].push(t);
    }

    for (const [category, catTests] of Object.entries(categories)) {
      console.log(`%c[${category.toUpperCase()}]`, 'color: #888; font-weight: bold;');

      for (const { name, fn } of catTests) {
        try {
          fn();
          passed++;
          console.log(`  %c PASS %c ${name}`, 'background: #4CAF50; color: white; padding: 1px 4px; border-radius: 2px;', '');
        } catch (e) {
          if (e.skip) {
            skipped++;
            console.log(`  %c SKIP %c ${name} - ${e.reason}`, 'background: #FF9800; color: white; padding: 1px 4px; border-radius: 2px;', 'color: #888;');
          } else {
            failed++;
            console.log(`  %c FAIL %c ${name}`, 'background: #f44336; color: white; padding: 1px 4px; border-radius: 2px;', '');
            console.error(`         ${e.message}`);
          }
        }
      }
    }

    console.log('\n' + '='.repeat(50));
    const resultColor = failed > 0 ? '#f44336' : '#4CAF50';
    console.log(`%cResults: ${passed} passed, ${failed} failed, ${skipped} skipped`,
      `color: ${resultColor}; font-weight: bold;`);

    if (failed === 0 && passed > 0) {
      console.log('%cAll systems operational!', 'color: #4CAF50; font-style: italic;');
    }

    return { passed, failed, skipped, total: filteredTests.length };
  }

  // Expose to global scope
  window.run404Tests = runAllTests;
  window.test404 = {
    runAll: runAllTests,
    tests,
    categories: () => [...new Set(tests.map(t => t.category))]
  };

  console.log('%c404 Game Tests Loaded!', 'color: #2196F3; font-weight: bold;');
  console.log('Run: run404Tests() or run404Tests("creature") for category filter');
  console.log('Categories:', [...new Set(tests.map(t => t.category))].join(', '));

})();
