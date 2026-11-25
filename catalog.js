/**
 * Catalogue scientifique immuable de recuperation WebRecovery.
 * Module ES2024+ zero-build compatible Navigateur et Node.js ESM.
 *
 * Securite physiologique encodee en donnees :
 * - KAATSU / BFR : unites proprietaires SKU selon guides fabricant KAATSU (Sato ; Nakajima ; Yasuda ; KAATSU Global protocols), distinctes des recommandations BFR en %LOP / mmHg (Patterson et al., 2019).
 * - IHHT / Hyperoxie : deux generateurs portables separes avec phase de bascule des masques (15 s) et arret SpO2 <= 80-85 % (Serebrovskaya & Xi, 2016).
 * - Bain froid : conflit strict < 4 h apres musculation / hypertrophie (Roberts et al., 2015).
 */

/**
 * Verrouille recursivement un objet ou un tableau (immuabilite stricte).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/**
 * Construit les phases alternees pour un cycle IHHT avec bascule manuelle entre les deux masques.
 * @param {number} cycles - Nombre de cycles hypoxie/hyperoxie.
 * @param {number} hypoxiaSec - Duree d'une phase hypoxique (secondes).
 * @param {number} hyperoxiaSec - Duree d'une phase hyperoxique (secondes).
 * @param {number} switchSec - Duree de bascule de masque (secondes).
 * @param {number} spo2StopPct - Seuil d'arret SpO2 (%).
 * @returns {Array<{label: string, sec: number}>}
 */
function buildIhhtPhases(cycles, hypoxiaSec, hyperoxiaSec, switchSec, spo2StopPct) {
  const phases = [
    { label: `Mise en place oxymetre & baseline SpO2 (arret si <= ${spo2StopPct} %)`, sec: 60 },
  ];
  for (let i = 1; i <= cycles; i++) {
    phases.push({
      label: `Cycle ${i}/${cycles} - Hypoxie (appareil hypoxie, surveiller SpO2 > ${spo2StopPct} %)`,
      sec: hypoxiaSec,
    });
    phases.push({
      label: `Cycle ${i}/${cycles} - Bascule masque : retirer hypoxie, poser hyperoxie`,
      sec: switchSec,
    });
    phases.push({
      label: `Cycle ${i}/${cycles} - Hyperoxie (appareil hyperoxie, reoxygenation)`,
      sec: hyperoxiaSec,
    });
    if (i < cycles) {
      phases.push({
        label: `Cycle ${i}/${cycles} - Bascule masque : retirer hyperoxie, poser hypoxie`,
        sec: switchSec,
      });
    }
  }
  phases.push({
    label: "Retrait masque, retour air ambiant & verification SpO2 >= 96 %",
    sec: 60,
  });
  return phases;
}

/**
 * Construit les cycles automatiques KAATSU Cycle 2.0 (<= 8 cycles ON/OFF de 30 s / 5 s par serie).
 * @param {string} limbLabel - Zone ciblee ("bras" ou "jambes").
 * @param {number} onSec - Duree de compression pneumatique (s).
 * @param {number} offSec - Duree de decompression (s).
 * @param {number} cycles - Nombre de cycles ON/OFF (<= 8 par serie).
 * @param {string} skuRange - Plage de pression SKU cible.
 * @param {string} [activityLabel] - Action motrice optionnelle pendant la compression.
 * @returns {Array<{label: string, sec: number}>}
 */
function buildKaatsuCyclePhases(limbLabel, onSec, offSec, cycles, skuRange, activityLabel = "") {
  const onSuffix = activityLabel ? ` — ${activityLabel}` : "";
  const phases = [
    { label: `Pose bandes ${limbLabel} + calibration Base SKU & Cycle 2.0 (${skuRange})`, sec: 45 },
  ];
  for (let i = 1; i <= cycles; i++) {
    phases.push({
      label: `Cycle ${i}/${cycles} ON - Compression pneumatique (${skuRange})${onSuffix}`,
      sec: onSec,
    });
    phases.push({
      label: `Cycle ${i}/${cycles} OFF - Decompression complete`,
      sec: offSec,
    });
  }
  phases.push({
    label: `Retrait bandes ${limbLabel} & controle remplissage capillaire (< 2 s)`,
    sec: 30,
  });
  return phases;
}

/**
 * Somme la duree totale d'un tableau de phases.
 * @param {Array<{sec: number, repeat?: number}>} phases
 * @returns {number}
 */
function sumPhasesSec(phases) {
  return phases.reduce((acc, p) => acc + p.sec * (p.repeat ?? 1), 0);
}

// =============================================================================
// 1. CONTRE-INDICATIONS CLINIQUES
// =============================================================================

const RAW_CONTRAINDICATIONS = [
  {
    id: "tvp_history",
    label: "Antecedent de TVP / phlebite / embolie pulmonaire",
    severity: "hard_block",
    description:
      "Toute occlusion veineuse partielle (KAATSU/BFR) ou compression pneumatique forte est strictement interdite en cas d'antecedent thrombo-embolique.",
    affectedModalities: ["kaatsu", "compression"],
    reference: "Patterson et al., 2019 (recommandations BFR en %LOP/mmHg, jamais en unites SKU)",
  },
  {
    id: "uncontrolled_hypertension",
    label: "Hypertension arterielle non controlee (> 160/100 mmHg)",
    severity: "hard_block",
    description:
      "Le reflexe presseur d'exercice sous BFR et les chocs thermiques (sauna, bain froid) augmentent brutalement la post-charge vasculaire.",
    affectedModalities: ["kaatsu", "thermal"],
    reference: "Cristina-Oliveira et al., 2020 ; Laukkanen et al., 2018",
  },
  {
    id: "pregnancy",
    label: "Grossesse",
    severity: "hard_block",
    description:
      "Exclusion par precaution de l'occlusion veineuse, de l'hyperthermie prolongee (sauna > 70 C), de l'hypoxie intermittente et des compressions abdominales.",
    affectedModalities: ["kaatsu", "hyperoxia_ihht", "thermal", "bolster_jacquier"],
    reference: "ACOG ; Patterson et al., 2019 (recommandations BFR en %LOP/mmHg, jamais en unites SKU)",
  },
  {
    id: "severe_varicose_veins",
    label: "Varices severes ou insuffisance veineuse chronique",
    severity: "hard_block",
    description:
      "Risque de stase veineuse aggravée et de thrombophlebite superficielle sous brassard BFR ou forte pression.",
    affectedModalities: ["kaatsu", "compression"],
    reference: "Patterson et al., 2019 (recommandations BFR en %LOP/mmHg, jamais en unites SKU)",
  },
  {
    id: "lymphedema_av_fistula",
    label: "Lymphoedeme ou fistule arterio-veineuse sur le membre",
    severity: "hard_block",
    description:
      "Interdiction absolue de garrot partiel ou de compression externe sur un membre porteur d'un trouble lymphatique ou d'un abord vasculaire.",
    affectedModalities: ["kaatsu", "compression"],
    reference: "Patterson et al., 2019 (recommandations BFR en %LOP/mmHg, jamais en unites SKU)",
  },
  {
    id: "cardiac_instability",
    label: "Cardiopathie instable, arythmie ou angor non equilibre",
    severity: "hard_block",
    description:
      "Les stress hypoxiques (IHHT), thermiques extremes et l'occlusion veineuse modulent fortement la balance sympatho-vagale.",
    affectedModalities: ["kaatsu", "hyperoxia_ihht", "thermal"],
    reference: "Serebrovskaya & Xi, 2016 ; Hussain & Cohen, 2018",
  },
  {
    id: "severe_respiratory_anemia",
    label: "BPCO severe, hypertension pulmonaire ou anemie severe",
    severity: "hard_block",
    description:
      "Contre-indique l'exposition hypoxique intermittente (IHHT) en raison d'une desaturation trop rapide et d'un risque d'hypoxie tissulaire.",
    affectedModalities: ["hyperoxia_ihht"],
    reference: "Serebrovskaya & Xi, 2016 ; Bayer et al., 2017",
  },
  {
    id: "acute_fever_infection",
    label: "Fievre, syndrome viral ou infection aigue",
    severity: "hard_block",
    description:
      "Toute contrainte thermique, hypoxique ou vasculaire majore le stress systemique pendant une phase infectieuse.",
    affectedModalities: ["kaatsu", "hyperoxia_ihht", "thermal", "compression"],
    reference: "Consensus medecine du sport",
  },
  {
    id: "cold_urticaria_raynaud",
    label: "Urticaire au froid, cryoglobulinemie ou syndrome de Raynaud severe",
    severity: "hard_block",
    description:
      "Risque de vasospasme digital severe, d'urticaire systemique ou d'ischemie peripherique lors de l'immersion en eau froide.",
    affectedModalities: ["thermal"],
    reference: "Tipton et al., 2017",
  },
  {
    id: "acute_trauma_open_wound",
    label: "Fracture non consolidee, lesion aigue (< 72 h) ou plaie ouverte",
    severity: "hard_block",
    description:
      "Eviter toute percussion, pression directe, etirement force ou compression pneumatique sur une zone lesee ou non cicatrisee.",
    affectedModalities: ["self_massage", "stretching", "kaatsu", "compression"],
    reference: "Pratique kinesitherapie du sport",
  },
  {
    id: "spinal_instability_radiculopathy",
    label: "Hernie discale aigue hyperalgique ou radiculopathie evolutive",
    severity: "caution",
    description:
      "Adapter ou suspendre les extensions passives sur bolster et les rotations rachidiennes si irradiation neurologique.",
    affectedModalities: ["bolster_jacquier", "stretching"],
    reference: "Pratique kinesitherapie rachidienne",
  },
  {
    id: "orthostatic_hypotension",
    label: "Hypotension orthostatique marquee ou vertiges recents",
    severity: "caution",
    description:
      "Relevage progressif obligatoire apres sauna ou decubitus dorsal prolonge sur bolster.",
    affectedModalities: ["thermal", "bolster_jacquier"],
    reference: "Laukkanen et al., 2018",
  },
];

// =============================================================================
// 2. MATERIEL & PLAFONDS DE SECURITE
// =============================================================================

const RAW_EQUIPMENT = [
  {
    id: "kaatsu_bands",
    name: "Bandes KAATSU pneumatiques (bras & jambes)",
    category: "bfr",
    description:
      "Brassards pneumatiques etroits dedies a la restriction veineuse controlee sans occlusion arterielle complete.",
    defaultAvailable: true,
    safetyLimits: {
      arms: {
        baseSkuRange: [80, 120],
        optimalSkuRange: [120, 200],
        maxSku: 220,
        maxContinuousMin: 15,
        firstSessionSupervised: true,
        progressiveStepCalibration: true,
      },
      legs: {
        baseSkuRange: [120, 180],
        optimalSkuRange: [180, 300],
        maxSku: 350,
        maxContinuousMin: 20,
        firstSessionSupervised: true,
        progressiveStepCalibration: true,
      },
      reference: "Sato ; Nakajima ; Yasuda ; KAATSU Global protocols (unites proprietaires SKU)",
      bfrReference: "Patterson et al., 2019 (recommandations BFR en %LOP/mmHg et durees max, jamais en unites SKU)",
    },
  },
  {
    id: "kaatsu_cycle_20",
    name: "Boitier KAATSU Cycle 2.0",
    category: "bfr",
    description:
      "Compresseur portable pilotant des cycles automatiques ON/OFF (30 s compression / 5 s decompression, <= 8 cycles par serie) et la montee progressive Base -> Optimal SKU.",
    defaultAvailable: true,
    safetyLimits: {
      autoCycleOnSec: 30,
      autoCycleOffSec: 5,
      stepsPerCycleSet: 8,
      maxCyclesPerSet: 8,
      maxSessionMin: 20,
      firstSessionSupervised: true,
      reference: "Sato ; Nakajima ; Yasuda ; KAATSU Global Cycle 2.0 Protocol",
    },
  },
  {
    id: "hyperoxia_gen",
    name: "Appareil portable hyperoxie (O2 enrichi)",
    category: "respiratory_gas",
    description:
      "Concentrateur/generateur portable delivrant un melange enrichi en oxygene (~35-95 %) via son propre masque.",
    defaultAvailable: true,
    safetyLimits: {
      noFlameOrGreaseNearO2: true,
      maxContinuousMin: 30,
      reference: "Sperlich et al., 2017",
    },
  },
  {
    id: "hypoxia_gen",
    name: "Appareil portable hypoxie separe (air appauvri en O2)",
    category: "respiratory_gas",
    description:
      "Generateur hypoxique independant (FiO2 ~9-15 %) avec masque separe. L'IHHT impose une phase de bascule manuelle entre les deux masques.",
    defaultAvailable: true,
    safetyLimits: {
      mandatoryOximeter: true,
      spo2StopThresholdPct: 82,
      spo2StopRangePct: [80, 85],
      minSingleHypoxiaSec: 180,
      maxSingleHypoxiaSec: 360,
      hyperoxiaRecoveryRangeSec: [120, 300],
      maskSwitchSec: 15,
      reference: "Serebrovskaya & Xi, 2016 ; Bayer et al., 2017",
    },
  },
  {
    id: "oximeter",
    name: "Oxymetre de pouls (SpO2 & FC)",
    category: "monitoring",
    description:
      "Capteur SpO2/FC au doigt ou oreille obligatoire pendant toute exposition hypoxique IHHT.",
    defaultAvailable: true,
    safetyLimits: {
      alarmThresholdPct: 85,
      hardStopThresholdPct: 80,
    },
  },
  {
    id: "bolster_jacquier",
    name: "Bolster Jacquier (decompression rachidienne)",
    category: "mobility",
    description:
      "Coussin cylindrique / demi-cylindrique ferme utilise en decubitus dorsal passif pour la decompression thoracique T6-T7 et l'ouverture anterieure.",
    defaultAvailable: true,
  },
  {
    id: "foam_roller",
    name: "Rouleau de massage (Foam Roller)",
    category: "self_massage",
    description:
      "Cylindre de relachement myofascial pour grands groupes musculaires et extension thoracique.",
    defaultAvailable: true,
  },
  {
    id: "massage_ball",
    name: "Balle de massage / Lacross",
    category: "self_massage",
    description:
      "Balle ferme (6-8 cm) pour points gachettes profonds, voute plantaire, piriforme et sous-occipitaux.",
    defaultAvailable: true,
  },
  {
    id: "massage_gun",
    name: "Pistolet de massage a percussion",
    category: "self_massage",
    description:
      "Appareil de therapie percussive (20-53 Hz) pour drainage local et reduction des raideurs sans frapper les saillies osseuses.",
    defaultAvailable: true,
    safetyLimits: {
      maxPerZoneSec: 120,
      avoidBonyProminences: true,
      reference: "Martin, 2021 ; Konrad et al., 2020",
    },
  },
  {
    id: "stretch_strap",
    name: "Sangle d'etirement multi-boucles",
    category: "mobility",
    description:
      "Sangle rigide permettant le controle de l'angle sans compensation lombaire ni tension cervicale.",
    defaultAvailable: true,
  },
  {
    id: "resistance_bands",
    name: "Elastiques de mobilisation (distraction articulaire)",
    category: "mobility",
    description:
      "Bandes elastiques fortes pour distraction talo-crurale (cheville), decoaptation de hanche et mobilite scapulaire.",
    defaultAvailable: true,
  },
  {
    id: "sauna",
    name: "Sauna (finlandais 75-95 C / infrarouge)",
    category: "thermal",
    description:
      "Exposition thermique seche favorisant le volume plasmatique, les proteines de choc thermique (HSP) et la vasodilatation.",
    defaultAvailable: false,
    safetyLimits: {
      tempRangeC: [75, 95],
      maxBoutMin: 20,
      hydrationMl: 500,
      reference: "Laukkanen et al., 2018 ; Scoon et al., 2007",
    },
  },
  {
    id: "cold_plunge",
    name: "Bain froid (10-14 C)",
    category: "thermal",
    description:
      "Immersion en eau froide pour attenuer la douleur percue apres effort intense d'endurance. Conflit hypertrophie < 4 h post-muscu.",
    defaultAvailable: false,
    safetyLimits: {
      tempRangeC: [10, 14],
      maxDurationSec: 600,
      conflictStrengthWindowHours: 4,
      reference: "Roberts et al., 2015 ; Moore et al., 2023",
    },
  },
  {
    id: "compression_boots",
    name: "Bottes de pressotherapie sequentielle",
    category: "compression",
    description:
      "Chambres pneumatiques distales vers proximales ameliorant le confort et la perception de jambes legeres.",
    defaultAvailable: false,
    safetyLimits: {
      pressureRangeMmHg: [40, 100],
      maxSessionMin: 30,
      reference: "Sands et al., 2015 ; Hoffman et al., 2016",
    },
  },
];

// =============================================================================
// 3. EXERCICES (~60 EXERCICES REPARTIS SUR 8 FAMILLES)
// =============================================================================

const RAW_EXERCISES = [
  // ---------------------------------------------------------------------------
  // FAMILLE 1 : STRETCHING (18 exercices : statique, PNF, dynamique, mobilite)
  // ---------------------------------------------------------------------------
  {
    id: "stretch_hamstring_strap_static",
    name: "Etirement ischio-jambiers a la sangle (statique)",
    family: "stretching",
    equipment: ["stretch_strap"],
    zones: ["hamstrings", "posterior_chain"],
    durationSec: 180,
    phases: [
      { label: "Jambe droite - maintien passif (bassin neutre)", sec: 90 },
      { label: "Jambe gauche - maintien passif (bassin neutre)", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "stretch_hamstring_strap",
    cues: [
      "Dos a plat au sol, genou deverrouille si tension derriere le genou.",
      "Intensite moderee (5/10), aucune douleur nerveuse type decharge.",
      "Expirer lentement pour relacher le tonus reflexe (Behm et al., 2016).",
    ],
  },
  {
    id: "stretch_hamstring_pnf",
    name: "Etirement ischio-jambiers PNF (contracter-relacher)",
    family: "stretching",
    equipment: ["stretch_strap"],
    zones: ["hamstrings"],
    durationSec: 168,
    phases: [
      { label: "Droite : pre-tension douce", sec: 15 },
      { label: "Droite : contraction isometrique 40 % dans la sangle", sec: 6, repeat: 3 },
      { label: "Droite : relachement & gain d'amplitude", sec: 17, repeat: 3 },
      { label: "Gauche : pre-tension douce", sec: 15 },
      { label: "Gauche : contraction isometrique 40 % dans la sangle", sec: 6, repeat: 3 },
      { label: "Gauche : relachement & gain d'amplitude", sec: 17, repeat: 3 },
    ],
    intensity: "moderate",
    contraindications: ["acute_trauma_open_wound", "spinal_instability_radiculopathy"],
    conflicts: ["high_fatigue_cns"],
    svg: "stretch_hamstring_pnf",
    cues: [
      "Contraction sous-maximale (30-50 %) sans bloquer la respiration.",
      "Gain d'amplitude passif immediatement pendant l'expiration post-contraction (Sharman et al., 2006).",
    ],
  },
  {
    id: "stretch_psoas_couch_static",
    name: "Etirement flechisseurs de hanche / psoas en fente basse",
    family: "stretching",
    equipment: [],
    zones: ["hip_flexors", "psoas", "quadriceps"],
    durationSec: 180,
    phases: [
      { label: "Cote droit - retroversion pelvienne active", sec: 90 },
      { label: "Cote gauche - retroversion pelvienne active", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "stretch_hip_flexor_lunge",
    cues: [
      "Serrer le fessier de la jambe arriere pour eviter de cambrer les lombaires.",
      "Indispensable apres position assise prolongee ou sortie velo.",
    ],
  },
  {
    id: "stretch_quad_strap_prone",
    name: "Etirement quadriceps en decubitus ventral a la sangle",
    family: "stretching",
    equipment: ["stretch_strap"],
    zones: ["quadriceps", "rectus_femoris"],
    durationSec: 160,
    phases: [
      { label: "Quadriceps droit - pubis plaque au sol", sec: 80 },
      { label: "Quadriceps gauche - pubis plaque au sol", sec: 80 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "pregnancy"],
    conflicts: [],
    svg: "stretch_quad_prone",
    cues: [
      "Garder le genou dans l'axe de la hanche, talon vers le fessier sans douleur rotulienne.",
    ],
  },
  {
    id: "stretch_glute_piriformis_figure4",
    name: "Etirement fessier & piriforme en chiffre 4",
    family: "stretching",
    equipment: [],
    zones: ["glutes", "piriformis", "hips"],
    durationSec: 150,
    phases: [
      { label: "Fessier droit - maintien calme", sec: 75 },
      { label: "Fessier gauche - maintien calme", sec: 75 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "stretch_figure4",
    cues: [
      "Flexion de cheville sur le pied croise pour proteger le ligament lateral du genou.",
      "Laisser le sacrum lourd au sol.",
    ],
  },
  {
    id: "stretch_adductor_frog_static",
    name: "Etirement adducteurs posture grenouille douce",
    family: "stretching",
    equipment: [],
    zones: ["adductors", "hips", "pelvis"],
    durationSec: 120,
    phases: [
      { label: "Ouverture progressive genoux flechis a 90 deg", sec: 120 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "stretch_frog",
    cues: [
      "Dos plat, reculer legerement le bassin vers les talons sur chaque expiration.",
    ],
  },
  {
    id: "stretch_calf_gastroc_soleus",
    name: "Etirement jumeaux & soleaire au mur",
    family: "stretching",
    equipment: [],
    zones: ["calves", "achilles", "ankle"],
    durationSec: 200,
    phases: [
      { label: "Jumeaux droit (genou tendu)", sec: 50 },
      { label: "Soleaire droit (genou flechi, talon au sol)", sec: 50 },
      { label: "Jumeaux gauche (genou tendu)", sec: 50 },
      { label: "Soleaire gauche (genou flechi, talon au sol)", sec: 50 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "stretch_calf_wall",
    cues: [
      "Pied oriente droit devant (eviter l'effondrement en pronation de l'arche).",
    ],
  },
  {
    id: "stretch_pec_doorway_pnf",
    name: "Ouverture pectoraux PNF (contracter-relacher)",
    family: "stretching",
    equipment: [],
    zones: ["pectorals", "shoulders", "anterior_chain"],
    durationSec: 140,
    phases: [
      { label: "Pectoral droit : mise en tension douce", sec: 20 },
      { label: "Pectoral droit : contraction 30 % contre cadre", sec: 6, repeat: 2 },
      { label: "Pectoral droit : relachement et ouverture", sec: 19, repeat: 2 },
      { label: "Pectoral gauche : mise en tension douce", sec: 20 },
      { label: "Pectoral gauche : contraction 30 % contre cadre", sec: 6, repeat: 2 },
      { label: "Pectoral gauche : relachement et ouverture", sec: 19, repeat: 2 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "stretch_pec_doorway",
    cues: [
      "Coudes a 90 deg puis 120 deg pour cibler grand et petit pectoral sans pincement anterieur d'epaule.",
    ],
  },
  {
    id: "stretch_lat_child_pose",
    name: "Etirement grand dorsal en priere laterale",
    family: "stretching",
    equipment: [],
    zones: ["lats", "thoracic_spine", "shoulders"],
    durationSec: 120,
    phases: [
      { label: "Inclinaison droite (grand dorsal gauche)", sec: 60 },
      { label: "Inclinaison gauche (grand dorsal droit)", sec: 60 },
    ],
    intensity: "very_low",
    contraindications: [],
    conflicts: [],
    svg: "stretch_child_lateral",
    cues: [
      "Respirer dans les cotes posterieures du cote etire.",
    ],
  },
  {
    id: "stretch_neck_upper_trap",
    name: "Etirement doux trapeze superieur & elevateur scapula",
    family: "stretching",
    equipment: [],
    zones: ["neck", "upper_traps"],
    durationSec: 120,
    phases: [
      { label: "Inclinaison gauche (trapeze droit), main dans le dos", sec: 60 },
      { label: "Inclinaison droite (trapeze gauche), main dans le dos", sec: 60 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "stretch_neck_trap",
    cues: [
      "Pression minimale de la main, abaisser l'epaule opposee activement.",
    ],
  },
  {
    id: "mob_thoracic_open_book",
    name: "Mobilite thoracique en rotation (Open Book)",
    family: "stretching",
    equipment: [],
    zones: ["thoracic_spine", "shoulders"],
    durationSec: 160,
    phases: [
      { label: "Rotation cote droit (8 repetitions lentes + maintien)", sec: 80 },
      { label: "Rotation cote gauche (8 repetitions lentes + maintien)", sec: 80 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "mob_open_book",
    cues: [
      "Garder le genou superieur fixe au sol ou sur coussin pour isoler la rotation thoracique.",
      "Suivre la main du regard sur une longue expiration.",
    ],
  },
  {
    id: "mob_cat_cow_segmental",
    name: "Mobilite rachidienne segmentaire (Cat-Cow lent)",
    family: "stretching",
    equipment: [],
    zones: ["thoracic_spine", "lumbar_spine", "pelvis"],
    durationSec: 120,
    phases: [
      { label: "Alternance flexion/extension vertebre par vertebre", sec: 120 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "mob_cat_cow",
    cues: [
      "Initier le mouvement par le bassin et remonter lentement jusqu'aux cervicales.",
    ],
  },
  {
    id: "mob_hip_90_90_switches",
    name: "Mobilite hanches 90/90 dynamique controlee",
    family: "stretching",
    equipment: [],
    zones: ["hips", "internal_rotation", "external_rotation"],
    durationSec: 150,
    phases: [
      { label: "Transitions lentes droite <-> gauche avec appui mains si besoin", sec: 150 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "mob_hip_9090",
    cues: [
      "Chercher la rotation interne en fin d'amplitude sans douleur au genou.",
    ],
  },
  {
    id: "mob_hip_band_distraction",
    name: "Distraction capsule anterieure de hanche a l'elastique",
    family: "stretching",
    equipment: ["resistance_bands"],
    zones: ["hips", "hip_flexors"],
    durationSec: 180,
    phases: [
      { label: "Hanche droite - micro-oscillations dans la fente", sec: 90 },
      { label: "Hanche gauche - micro-oscillations dans la fente", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "mob_hip_band",
    cues: [
      "Elastique haut dans le pli inguinal, traction vers l'avant/bas.",
    ],
  },
  {
    id: "mob_ankle_wblt_lunge",
    name: "Mobilite dorsiflexion cheville en charge (test WBLT)",
    family: "stretching",
    equipment: [],
    zones: ["ankle", "soleus", "achilles"],
    durationSec: 160,
    phases: [
      { label: "Cheville droite : 12 oscillations genou vers 2e orteil", sec: 80 },
      { label: "Cheville gauche : 12 oscillations genou vers 2e orteil", sec: 80 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "mob_ankle_wblt",
    cues: [
      "Talon 100 % plaque au sol ; passer le genou dans l'axe du 2e-3e orteil.",
      "Lien suivi WBLT : wblt-ankle-pwa (Konor et al., 2012).",
    ],
  },
  {
    id: "mob_ankle_band_talocrural",
    name: "Distraction talo-crurale de cheville a l'elastique",
    family: "stretching",
    equipment: ["resistance_bands"],
    zones: ["ankle", "talocrural_joint"],
    durationSec: 180,
    phases: [
      { label: "Cheville droite : traction posterieure sur le talus + fente", sec: 90 },
      { label: "Cheville gauche : traction posterieure sur le talus + fente", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "mob_ankle_band",
    cues: [
      "Placer l'elastique sous les malleoles (sur le talus, pas sur le tibia) pour liberer le glissement posterieur (Terada et al., 2013).",
    ],
  },
  {
    id: "mob_shoulder_band_dislocates",
    name: "Mobilite dynamique ceinture scapulaire a l'elastique",
    family: "stretching",
    equipment: ["resistance_bands"],
    zones: ["shoulders", "scapula", "pectorals"],
    durationSec: 120,
    phases: [
      { label: "Passages lents avant-arriere (prise large, bras tendus)", sec: 120 },
    ],
    intensity: "very_low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "mob_shoulder_band",
    cues: [
      "Elargir la prise si les cotes se soulevent ou si une epaule craque douloureusement.",
    ],
  },
  {
    id: "dyn_world_greatest_flow",
    name: "Flux dynamique World's Greatest Stretch (version recuperation)",
    family: "stretching",
    equipment: [],
    zones: ["hips", "thoracic_spine", "hamstrings", "ankle"],
    durationSec: 180,
    phases: [
      { label: "Cote droit : fente + rotation thoracique + extension ischio", sec: 90 },
      { label: "Cote gauche : fente + rotation thoracique + extension ischio", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "dyn_wgs",
    cues: [
      "Rythme fluide et respiratoire sans a-coup ; ideal en repos actif ou veille de competition.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 2 : BOLSTER JACQUIER (6 exercices de decompression passive)
  // ---------------------------------------------------------------------------
  {
    id: "bolster_t6t7_decompression",
    name: "Decompression dorsale T6-T7 sur bolster Jacquier",
    family: "bolster_jacquier",
    equipment: ["bolster_jacquier"],
    zones: ["thoracic_spine", "t6_t7", "rib_cage"],
    durationSec: 300,
    phases: [
      { label: "Installation T6-T7 (pointe des omoplates) & relachement bras", sec: 60 },
      { label: "Decompression passive + respiration costale lente", sec: 180 },
      { label: "Retrait lateral du bolster & retour a plat dos", sec: 60 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy", "orthostatic_hypotension"],
    conflicts: [],
    svg: "bolster_t6t7",
    cues: [
      "Placer l'axe du bolster perpendiculairement sous T6-T7 (juste sous l'angle inferieur des scapulas).",
      "Relier au protocole reset-t6t7-pwa ; soutenir la tete si menton projete vers l'arriere.",
      "Ne jamais se redresser tout droit : basculer sur le cote pour sortir du bolster.",
    ],
  },
  {
    id: "bolster_thoracic_longitudinal",
    name: "Ouverture thoracique longitudinale sur bolster Jacquier",
    family: "bolster_jacquier",
    equipment: ["bolster_jacquier"],
    zones: ["thoracic_spine", "pectorals", "shoulders"],
    durationSec: 240,
    phases: [
      { label: "Axe vertebral aligne sur le bolster, paumes vers le plafond", sec: 180 },
      { label: "Bras en chandelier bas (W) & respiration diaphragmatique", sec: 60 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "bolster_longitudinal",
    cues: [
      "Tete et sacrum entierement supportes ; laisser la gravite ouvrir les grands pectoraux.",
    ],
  },
  {
    id: "bolster_psoas_passive",
    name: "Relachement passif du psoas & decompression sacro-iliaque",
    family: "bolster_jacquier",
    equipment: ["bolster_jacquier"],
    zones: ["psoas", "hip_flexors", "lumbar_spine"],
    durationSec: 240,
    phases: [
      { label: "Bolster sous le sacrum, jambe droite allongee (gauche flechie)", sec: 120 },
      { label: "Bolster sous le sacrum, jambe gauche allongee (droite flechie)", sec: 120 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy", "pregnancy"],
    conflicts: [],
    svg: "bolster_psoas",
    cues: [
      "Bolster place sous le sacrum (jamais dans le creux lombaire pur).",
      "Si tiraillement lombaire, flechir legerement le genou de la jambe etendue.",
    ],
  },
  {
    id: "bolster_diaphragm_release",
    name: "Decompression thoraco-diaphragmatique sur bolster",
    family: "bolster_jacquier",
    equipment: ["bolster_jacquier"],
    zones: ["diaphragm", "rib_cage", "thoracic_spine"],
    durationSec: 240,
    phases: [
      { label: "Bolster transversal sous la charniere T11-T12 + expiration longue", sec: 240 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy", "pregnancy"],
    conflicts: [],
    svg: "bolster_diaphragm",
    cues: [
      "Inspirer 4 s dans les basses cotes laterales, expirer 8 s en laissant le sternum s'abaisser.",
    ],
  },
  {
    id: "bolster_lumbar_legs_elevated",
    name: "Decompression lombaire passive (mollets sur bolster)",
    family: "bolster_jacquier",
    equipment: ["bolster_jacquier"],
    zones: ["lumbar_spine", "psoas", "calves"],
    durationSec: 300,
    phases: [
      { label: "Position Psoas Position / repos lombaire 90-90", sec: 300 },
    ],
    intensity: "very_low",
    contraindications: [],
    conflicts: [],
    svg: "bolster_lumbar_rest",
    cues: [
      "Decharge immediate de la pression intradiscale lombaire (Nachemson, 1981).",
    ],
  },
  {
    id: "bolster_cervico_thoracic_reset",
    name: "Relachement cervico-thoracique haut (T1-T4) sur bolster",
    family: "bolster_jacquier",
    equipment: ["bolster_jacquier"],
    zones: ["upper_thoracic", "neck", "trapezius"],
    durationSec: 180,
    phases: [
      { label: "Bolster transversal sous haut des omoplates + micro-mouvements bras", sec: 180 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy", "orthostatic_hypotension"],
    conflicts: [],
    svg: "bolster_upper_thoracic",
    cues: [
      "Tres utile apres conduite prolongee ou travail sur ecran.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 3 : AUTO-MASSAGE (12 exercices : rouleau, balle, pistolet)
  // ---------------------------------------------------------------------------
  {
    id: "sm_roller_quads",
    name: "Auto-massage quadriceps au rouleau",
    family: "self_massage",
    equipment: ["foam_roller"],
    zones: ["quadriceps"],
    durationSec: 180,
    phases: [
      { label: "Quadriceps droit (balayage lent + 2 points sensibles)", sec: 90 },
      { label: "Quadriceps gauche (balayage lent + 2 points sensibles)", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "roller_quads",
    cues: [
      "Vitesse lente (~2-3 cm/s), s'arreter 20 s sur les zones tendues en respirant (Cheatham et al., 2015).",
    ],
  },
  {
    id: "sm_roller_tfl_itb",
    name: "Auto-massage TFL & bandelette laterale (rouleau doux)",
    family: "self_massage",
    equipment: ["foam_roller"],
    zones: ["tfl", "vastus_lateralis", "hips"],
    durationSec: 160,
    phases: [
      { label: "Cote droit : focus TFL et vaste externe (eviter le genou)", sec: 80 },
      { label: "Cote gauche : focus TFL et vaste externe (eviter le genou)", sec: 80 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "roller_lateral",
    cues: [
      "Decharger une partie du poids avec le pied oppose ; viser le TFL et le vaste externe plutot que d'ecraser le tendon.",
    ],
  },
  {
    id: "sm_roller_calves",
    name: "Auto-massage mollets au rouleau",
    family: "self_massage",
    equipment: ["foam_roller"],
    zones: ["calves", "soleus"],
    durationSec: 160,
    phases: [
      { label: "Mollet droit (balayage interne/externe + flexions cheville)", sec: 80 },
      { label: "Mollet gauche (balayage interne/externe + flexions cheville)", sec: 80 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "tvp_history"],
    conflicts: [],
    svg: "roller_calves",
    cues: [
      "Rester sur le ventre musculaire, jamais directement sur le tendon d'Achille ou le creux poplite.",
    ],
  },
  {
    id: "sm_roller_thoracic",
    name: "Extension & massage thoracique au rouleau",
    family: "self_massage",
    equipment: ["foam_roller"],
    zones: ["thoracic_spine"],
    durationSec: 120,
    phases: [
      { label: "3 niveaux dorsaux (T4 -> T8), mains derriere la nuque", sec: 120 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "roller_thoracic",
    cues: [
      "Ne jamais rouler sur les vertebres lombaires ; bloquer les cotes basses avant chaque extension.",
    ],
  },
  {
    id: "sm_roller_lats",
    name: "Auto-massage grand dorsal au rouleau",
    family: "self_massage",
    equipment: ["foam_roller"],
    zones: ["lats", "teres_major"],
    durationSec: 140,
    phases: [
      { label: "Grand dorsal droit (sous l'aisselle, bras allonge)", sec: 70 },
      { label: "Grand dorsal gauche (sous l'aisselle, bras allonge)", sec: 70 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "roller_lats",
    cues: [
      "Rotation lente d'avant en arriere sur le bord externe de la scapula.",
    ],
  },
  {
    id: "sm_ball_plantar_fascia",
    name: "Relachement voute plantaire a la balle",
    family: "self_massage",
    equipment: ["massage_ball"],
    zones: ["plantar_fascia", "foot", "ankle"],
    durationSec: 160,
    phases: [
      { label: "Pied droit (arche interne, centrale, avant-pied)", sec: 80 },
      { label: "Pied gauche (arche interne, centrale, avant-pied)", sec: 80 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "ball_plantar",
    cues: [
      "Pression controlee debout ou assis ; ameliore la souplesse de toute la chaine posterieure (Grieve et al., 2015).",
    ],
  },
  {
    id: "sm_ball_piriformis_glute",
    name: "Relachement fessier & piriforme a la balle",
    family: "self_massage",
    equipment: ["massage_ball"],
    zones: ["glutes", "piriformis"],
    durationSec: 160,
    phases: [
      { label: "Fessier droit (points gachettes + croisement cheville)", sec: 80 },
      { label: "Fessier gauche (points gachettes + croisement cheville)", sec: 80 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "ball_glute",
    cues: [
      "Si sensation de fourmillement dans la jambe (nerf sciatique), deplacer immediatement la balle.",
    ],
  },
  {
    id: "sm_ball_pecs",
    name: "Relachement grand & petit pectoral a la balle (contre mur)",
    family: "self_massage",
    equipment: ["massage_ball"],
    zones: ["pectorals", "anterior_shoulder"],
    durationSec: 120,
    phases: [
      { label: "Pectoral droit sous la clavicule", sec: 60 },
      { label: "Pectoral gauche sous la clavicule", sec: 60 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound"],
    conflicts: [],
    svg: "ball_pecs",
    cues: [
      "Lever doucement le bras le long du mur pendant que la balle maintient la pression.",
    ],
  },
  {
    id: "sm_ball_suboccipital",
    name: "Relachement sous-occipital a la balle",
    family: "self_massage",
    equipment: ["massage_ball"],
    zones: ["neck", "suboccipitals"],
    durationSec: 120,
    phases: [
      { label: "Pression statique douce base du crane + micro-oui/non", sec: 120 },
    ],
    intensity: "very_low",
    contraindications: ["spinal_instability_radiculopathy"],
    conflicts: [],
    svg: "ball_suboccipital",
    cues: [
      "Poids de la tete uniquement ; favorise la detente vagale et reduit les cephalees de tension.",
    ],
  },
  {
    id: "sm_gun_quads",
    name: "Percussion pistolet de massage — quadriceps",
    family: "self_massage",
    equipment: ["massage_gun"],
    zones: ["quadriceps"],
    durationSec: 180,
    phases: [
      { label: "Quadriceps droit (embout rond, vitesse basse/moyenne)", sec: 90 },
      { label: "Quadriceps gauche (embout rond, vitesse basse/moyenne)", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "tvp_history"],
    conflicts: ["sleep_lt_1h"],
    svg: "gun_quads",
    cues: [
      "Glisser dans le sens des fibres (<= 90-120 s/muscle) sans appuyer fortement ni toucher la rotule (Konrad et al., 2020).",
    ],
  },
  {
    id: "sm_gun_calves",
    name: "Percussion pistolet de massage — mollets & soleaires",
    family: "self_massage",
    equipment: ["massage_gun"],
    zones: ["calves", "soleus"],
    durationSec: 150,
    phases: [
      { label: "Mollet droit (corps musculaire uniquement)", sec: 75 },
      { label: "Mollet gauche (corps musculaire uniquement)", sec: 75 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "tvp_history", "severe_varicose_veins"],
    conflicts: [],
    svg: "gun_calves",
    cues: [
      "Eviter le tendon d'Achille, la tete du perone et le creux poplite.",
    ],
  },
  {
    id: "sm_gun_glutes_hamstrings",
    name: "Percussion pistolet de massage — fessiers & ischios",
    family: "self_massage",
    equipment: ["massage_gun"],
    zones: ["glutes", "hamstrings"],
    durationSec: 180,
    phases: [
      { label: "Cote droit : grand/moyen fessier puis ischio-jambiers", sec: 90 },
      { label: "Cote gauche : grand/moyen fessier puis ischio-jambiers", sec: 90 },
    ],
    intensity: "low",
    contraindications: ["acute_trauma_open_wound", "tvp_history"],
    conflicts: [],
    svg: "gun_posterior",
    cues: [
      "Rester a distance de la tuberosite ischiatique et du grand trochanter.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 4 : KAATSU / BFR (6 exercices avec Cycle 2.0 & securite stricte)
  // ---------------------------------------------------------------------------
  {
    id: "kaatsu_cycle_legs_progressive",
    name: "KAATSU Cycle 2.0 passif — jambes (mode progressif SKU)",
    family: "kaatsu",
    equipment: ["kaatsu_bands", "kaatsu_cycle_20"],
    zones: ["quadriceps", "hamstrings", "calves", "vascular_lower"],
    durationSec: sumPhasesSec(buildKaatsuCyclePhases("jambes", 30, 5, 8, "Base 140 -> Optimal 240 SKU")),
    phases: buildKaatsuCyclePhases("jambes", 30, 5, 8, "Base 140 -> Optimal 240 SKU"),
    intensity: "low",
    contraindications: [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "cardiac_instability",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: ["first_kaatsu_unsupervised"],
    svg: "kaatsu_legs_cycle",
    cues: [
      "Position : haut des cuisses (pli inguinal). Base SKU : 120-180, Optimal SKU <= 300, plafond 350 SKU (<= 400 SKU max jambes ; Sato ; Nakajima ; Yasuda ; KAATSU Global protocols).",
      "Premiere utilisation supervisee et calibree obligatoire ; progression par paliers Base -> Optimal SKU. Arret immediat si engourdissement, paresthesie ou paleur.",
      "Ne jamais depasser 20 min de seance (principes de securite BFR en %LOP/mmHg : Patterson et al., 2019) ; verifier retour capillaire < 2 s.",
    ],
  },
  {
    id: "kaatsu_cycle_arms_progressive",
    name: "KAATSU Cycle 2.0 passif — bras (mode progressif SKU)",
    family: "kaatsu",
    equipment: ["kaatsu_bands", "kaatsu_cycle_20"],
    zones: ["biceps", "triceps", "forearms", "vascular_upper"],
    durationSec: sumPhasesSec(buildKaatsuCyclePhases("bras", 30, 5, 8, "Base 90 -> Optimal 160 SKU")),
    phases: buildKaatsuCyclePhases("bras", 30, 5, 8, "Base 90 -> Optimal 160 SKU"),
    intensity: "low",
    contraindications: [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "cardiac_instability",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: ["first_kaatsu_unsupervised"],
    svg: "kaatsu_arms_cycle",
    cues: [
      "Position : tiers proximal du bras (sous le deltoide). Base SKU : 80-120, Optimal SKU <= 200, plafond 220 SKU (<= 250 SKU max bras ; Sato ; Nakajima ; Yasuda ; KAATSU Global protocols).",
      "Premiere utilisation supervisee et calibree obligatoire ; progression par paliers Base -> Optimal SKU. La peau doit rester rosee (jamais cyanosee).",
      "Ne jamais depasser 15 min de seance (principes de securite BFR en %LOP/mmHg : Patterson et al., 2019) ; verifier retour capillaire < 2 s.",
    ],
  },
  {
    id: "kaatsu_cycle_legs_recovery_soft",
    name: "KAATSU recuperation vasculaire douce — jambes (Cycle 2.0 : 30s ON / 5s OFF)",
    family: "kaatsu",
    equipment: ["kaatsu_bands", "kaatsu_cycle_20"],
    zones: ["legs", "vascular_lower"],
    durationSec: sumPhasesSec(buildKaatsuCyclePhases("jambes", 30, 5, 6, "Base 120 -> Doux 140-180 SKU")),
    phases: buildKaatsuCyclePhases("jambes", 30, 5, 6, "Base 120 -> Doux 140-180 SKU"),
    intensity: "very_low",
    contraindications: [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "cardiac_instability",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: ["first_kaatsu_unsupervised"],
    svg: "kaatsu_legs_soft",
    cues: [
      "Pression basse par paliers (Base 120 -> 140-180 SKU, <= 400 SKU max jambes ; Sato ; Nakajima ; Yasuda ; KAATSU Global protocols) en Cycle 2.0 (30 s ON / 5 s OFF) pour favoriser le flush endotheline/NO (Horiuchi & Okita, 2012).",
      "Premiere utilisation supervisee et calibree obligatoire ; verifier retour capillaire < 2 s.",
    ],
  },
  {
    id: "kaatsu_cycle_arms_recovery_soft",
    name: "KAATSU recuperation vasculaire douce — bras (Cycle 2.0 : 30s ON / 5s OFF)",
    family: "kaatsu",
    equipment: ["kaatsu_bands", "kaatsu_cycle_20"],
    zones: ["arms", "vascular_upper"],
    durationSec: sumPhasesSec(buildKaatsuCyclePhases("bras", 30, 5, 6, "Base 80 -> Doux 90-120 SKU")),
    phases: buildKaatsuCyclePhases("bras", 30, 5, 6, "Base 80 -> Doux 90-120 SKU"),
    intensity: "very_low",
    contraindications: [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "cardiac_instability",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: ["first_kaatsu_unsupervised"],
    svg: "kaatsu_arms_soft",
    cues: [
      "Pression basse par paliers (Base 80 -> 90-120 SKU, <= 250 SKU max bras ; Sato ; Nakajima ; Yasuda ; KAATSU Global protocols) en Cycle 2.0 (30 s ON / 5 s OFF) pour stimuler le retour veineux sans contrainte mecanique.",
      "Premiere utilisation supervisee et calibree obligatoire ; verifier retour capillaire < 2 s.",
    ],
  },
  {
    id: "kaatsu_walk_light",
    name: "KAATSU Walk leger (marche a basse pression sous Cycle 2.0)",
    family: "kaatsu",
    equipment: ["kaatsu_bands", "kaatsu_cycle_20"],
    zones: ["legs", "cardiovascular", "systemic"],
    durationSec: sumPhasesSec(
      buildKaatsuCyclePhases("jambes", 30, 5, 8, "Base 120-160 -> Optimal 160-220 SKU", "Marche lente plate 3.5-4.5 km/h"),
    ),
    phases: buildKaatsuCyclePhases(
      "jambes",
      30,
      5,
      8,
      "Base 120-160 -> Optimal 160-220 SKU",
      "Marche lente plate 3.5-4.5 km/h",
    ),
    intensity: "low",
    contraindications: [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "cardiac_instability",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: ["first_kaatsu_unsupervised", "high_fatigue_cns"],
    svg: "kaatsu_walk",
    cues: [
      "Marche sous Cycle 2.0 (30 s ON / 5 s OFF, <= 8 cycles/serie ; paliers Base 120-160 -> Optimal 160-220 SKU, <= 400 SKU max jambes ; Sato ; Nakajima ; Yasuda ; KAATSU Global protocols).",
      "Premiere utilisation supervisee et calibree obligatoire ; reponse hormonale/capillaire sans dommage musculaire (Abe et al., 2006 ; principes generaux BFR en %LOP/mmHg : Patterson et al., 2019).",
      "Duree stricte <= 10-15 min en marche ; stopper si douleur crurale inhabituelle et controler le pouls pedieux.",
    ],
  },
  {
    id: "kaatsu_ankle_mobility_cycles",
    name: "Mobilite douce cheville/mollet sous KAATSU Cycle 2.0",
    family: "kaatsu",
    equipment: ["kaatsu_bands", "kaatsu_cycle_20"],
    zones: ["ankle", "calves", "legs"],
    durationSec: sumPhasesSec(
      buildKaatsuCyclePhases("jambes", 30, 5, 8, "Base 120 -> Optimal 140-200 SKU", "Pompes cheville & flexions plantaires"),
    ),
    phases: buildKaatsuCyclePhases(
      "jambes",
      30,
      5,
      8,
      "Base 120 -> Optimal 140-200 SKU",
      "Pompes cheville & flexions plantaires",
    ),
    intensity: "low",
    contraindications: [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "cardiac_instability",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: ["first_kaatsu_unsupervised"],
    svg: "kaatsu_ankle",
    cues: [
      "Contractions lentes sans charge externe en Cycle 2.0 (30 s ON / 5 s OFF, <= 8 cycles/serie ; paliers Base 120 -> 140-200 SKU, <= 400 SKU max jambes ; Sato ; Nakajima ; Yasuda ; KAATSU Global protocols).",
      "Premiere utilisation supervisee et calibree obligatoire ; verifier retour capillaire < 2 s.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 5 : HYPEROXIE / IHHT (5 exercices avec bascule des 2 masques & SpO2)
  // ---------------------------------------------------------------------------
  {
    id: "ihht_standard_5_3",
    name: "IHHT standard 5' hypoxie / 3' hyperoxie (4 cycles)",
    family: "hyperoxia_ihht",
    equipment: ["hypoxia_gen", "hyperoxia_gen", "oximeter"],
    zones: ["systemic", "mitochondria", "autonomic"],
    durationSec: sumPhasesSec(buildIhhtPhases(4, 300, 180, 15, 82)),
    phases: buildIhhtPhases(4, 300, 180, 15, 82),
    intensity: "low",
    contraindications: [
      "severe_respiratory_anemia",
      "cardiac_instability",
      "pregnancy",
      "acute_fever_infection",
    ],
    conflicts: ["missing_oximeter", "sleep_lt_2h"],
    svg: "ihht_standard",
    cues: [
      "Oxymetre obligatoire en continu. Arret immediat de la phase hypoxique et bascule sur hyperoxie si SpO2 <= 82 % (zone limite 80-85 % ; Serebrovskaya & Xi, 2016).",
      "Deux appareils separes : utiliser la phase de 15 s pour changer proprement de masque.",
      "Securite O2 : aucune flamme, bougie ni corps gras a proximite du generateur d'hyperoxie.",
    ],
  },
  {
    id: "ihht_gentle_hrv_4_4",
    name: "IHHT doux HRV basse 4' hypoxie / 4' hyperoxie (3 cycles)",
    family: "hyperoxia_ihht",
    equipment: ["hypoxia_gen", "hyperoxia_gen", "oximeter"],
    zones: ["systemic", "autonomic", "hrv"],
    durationSec: sumPhasesSec(buildIhhtPhases(3, 240, 240, 15, 85)),
    phases: buildIhhtPhases(3, 240, 240, 15, 85),
    intensity: "very_low",
    contraindications: [
      "severe_respiratory_anemia",
      "cardiac_instability",
      "pregnancy",
      "acute_fever_infection",
    ],
    conflicts: ["missing_oximeter"],
    svg: "ihht_gentle",
    cues: [
      "Seuil SpO2 protecteur remonte a 85 % (>= plancher absolu 80 %) pour limiter le stress sympathique en periode de HRV basse (Bayer et al., 2017).",
      "Respiration nasale calme durant chaque bascule de masque (15 s).",
    ],
  },
  {
    id: "ihht_calibration_tolerance",
    name: "Calibration IHHT & test tolerance hypoxique court",
    family: "hyperoxia_ihht",
    equipment: ["hypoxia_gen", "hyperoxia_gen", "oximeter"],
    zones: ["systemic", "respiratory"],
    durationSec: sumPhasesSec(buildIhhtPhases(2, 180, 180, 15, 84)),
    phases: buildIhhtPhases(2, 180, 180, 15, 84),
    intensity: "very_low",
    contraindications: [
      "severe_respiratory_anemia",
      "cardiac_instability",
      "pregnancy",
      "acute_fever_infection",
    ],
    conflicts: ["missing_oximeter"],
    svg: "ihht_calibration",
    cues: [
      "Permet d'observer la cinetique de descente de SpO2 avant un protocole complet.",
      "Interrompre la phase hypoxique des SpO2 <= 84 % (plancher absolu <= 80 %) ou sensation de vertige.",
    ],
  },
  {
    id: "hyperoxia_post_hiit_15",
    name: "Hyperoxie pure post-HIIT (15 min)",
    family: "hyperoxia_ihht",
    equipment: ["hyperoxia_gen", "oximeter"],
    zones: ["systemic", "cardiovascular"],
    durationSec: 960,
    phases: [
      { label: "Installation masque hyperoxie & controle oxymetre", sec: 30 },
      { label: "Respiration calme sous O2 enrichi (position assise/semi-allongee)", sec: 900 },
      { label: "Retrait masque & controle FC de repos", sec: 30 },
    ],
    intensity: "very_low",
    contraindications: ["cardiac_instability", "acute_fever_infection"],
    conflicts: [],
    svg: "hyperoxia_post",
    cues: [
      "Facilite la resynthese de PCr et le retour vagal post-effort intense (Sperlich et al., 2017).",
      "Tenir a l'ecart de toute flamme et de tout corps gras.",
    ],
  },
  {
    id: "hyperoxia_express_10",
    name: "Hyperoxie express inter-blocs ou retour au calme (10 min)",
    family: "hyperoxia_ihht",
    equipment: ["hyperoxia_gen", "oximeter"],
    zones: ["systemic", "respiratory"],
    durationSec: 630,
    phases: [
      { label: "Mise en place masque hyperoxie & oxymetre", sec: 30 },
      { label: "Ventilation nasale calme sous air enrichi en O2", sec: 600 },
    ],
    intensity: "very_low",
    contraindications: ["cardiac_instability", "acute_fever_infection"],
    conflicts: [],
    svg: "hyperoxia_express",
    cues: [
      "Respiration lente sans hyperventiler ; garder les epaules relachees.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 6 : THERMIQUE (5 exercices : sauna, froid, contraste)
  // ---------------------------------------------------------------------------
  {
    id: "thermal_sauna_endurance",
    name: "Sauna recuperation post-endurance (15 min + refroidissement)",
    family: "thermal",
    equipment: ["sauna"],
    zones: ["systemic", "cardiovascular"],
    durationSec: 1200,
    phases: [
      { label: "Passage sauna 80-90 C (hydratation prealable 500 ml)", sec: 900 },
      { label: "Refroidissement air ambiant / douche tiede + rehydratation", sec: 300 },
    ],
    intensity: "low",
    contraindications: [
      "uncontrolled_hypertension",
      "cardiac_instability",
      "pregnancy",
      "acute_fever_infection",
      "orthostatic_hypotension",
    ],
    conflicts: ["dehydration", "sleep_lt_1h"],
    svg: "thermal_sauna",
    cues: [
      "Favorise l'expansion du volume plasmatique apres entrainement d'endurance (Scoon et al., 2007 ; Laukkanen et al., 2018).",
      "Sortir immediatement si vertige ou oppression ; boire eau + electrolytes apres.",
    ],
  },
  {
    id: "thermal_sauna_evening_short",
    name: "Sauna court vespéral (12 min, 2 h avant coucher)",
    family: "thermal",
    equipment: ["sauna"],
    zones: ["systemic", "sleep"],
    durationSec: 1020,
    phases: [
      { label: "Passage sauna modere 75-85 C", sec: 720 },
      { label: "Douche tiede progressive & chute thermique centrale", sec: 300 },
    ],
    intensity: "very_low",
    contraindications: [
      "uncontrolled_hypertension",
      "cardiac_instability",
      "pregnancy",
      "acute_fever_infection",
      "orthostatic_hypotension",
    ],
    conflicts: ["sleep_lt_90m", "dehydration"],
    svg: "thermal_sauna_evening",
    cues: [
      "Planifier 90-120 min avant le coucher pour declencher le rebond hypothermique propice au sommeil profond (Kräuchi, 2007).",
    ],
  },
  {
    id: "thermal_cold_plunge_full",
    name: "Bain froid corps entier (10-12 C, 6 min) — HORS MUSCU",
    family: "thermal",
    equipment: ["cold_plunge"],
    zones: ["systemic", "legs"],
    durationSec: 420,
    phases: [
      { label: "Entree progressive & controle expiration lente", sec: 60 },
      { label: "Immersion calme jusqu'aux epaules (10-12 C)", sec: 300 },
      { label: "Sortie & rechauffement passif sec (sans douche brulante)", sec: 60 },
    ],
    intensity: "moderate",
    contraindications: [
      "cold_urticaria_raynaud",
      "uncontrolled_hypertension",
      "cardiac_instability",
      "acute_fever_infection",
    ],
    conflicts: ["strength_lt_4h"],
    svg: "thermal_cold_plunge",
    cues: [
      "INTERDIT < 4 h apres musculation / hypertrophie : attenue la voie mTOR et l'adaptation musculaire (Roberts et al., 2015).",
      "Pertinent apres HIIT velo ou tournoi pour reduire les DOMS (Moore et al., 2023).",
    ],
  },
  {
    id: "thermal_cold_plunge_legs",
    name: "Bain froid membres inferieurs seuls (10-14 C, 8 min)",
    family: "thermal",
    equipment: ["cold_plunge"],
    zones: ["legs", "calves", "quadriceps"],
    durationSec: 480,
    phases: [
      { label: "Immersion jusqu'a mi-cuisse / hanches, respiration nasale", sec: 480 },
    ],
    intensity: "low",
    contraindications: [
      "cold_urticaria_raynaud",
      "uncontrolled_hypertension",
      "cardiac_instability",
      "acute_fever_infection",
    ],
    conflicts: ["strength_lt_4h"],
    svg: "thermal_cold_legs",
    cues: [
      "Conflit identique < 4 h apres musculation des jambes (Roberts et al., 2015).",
    ],
  },
  {
    id: "thermal_contrast_sauna_cold",
    name: "Therapie par contraste chaud/froid (3 cycles)",
    family: "thermal",
    equipment: ["sauna", "cold_plunge"],
    zones: ["systemic", "vascular"],
    durationSec: 1380,
    phases: [
      { label: "Cycle 1 - Sauna 80-90 C", sec: 360 },
      { label: "Cycle 1 - Bain froid 10-14 C", sec: 90 },
      { label: "Cycle 2 - Sauna 80-90 C", sec: 360 },
      { label: "Cycle 2 - Bain froid 10-14 C", sec: 90 },
      { label: "Cycle 3 - Sauna 80-90 C", sec: 360 },
      { label: "Cycle 3 - Froid final court & retour tempere", sec: 120 },
    ],
    intensity: "moderate",
    contraindications: [
      "cold_urticaria_raynaud",
      "uncontrolled_hypertension",
      "cardiac_instability",
      "pregnancy",
      "acute_fever_infection",
      "orthostatic_hypotension",
    ],
    conflicts: ["strength_lt_4h", "sleep_lt_2h"],
    svg: "thermal_contrast",
    cues: [
      "Alternance vasodilatation/vasoconstriction ameliorant le ressenti de recuperation (Bieuzen et al., 2013).",
      "Interdit < 4 h post-muscu en raison de la composante froide.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 7 : PRESSOTHERAPIE (4 exercices bottes de compression)
  // ---------------------------------------------------------------------------
  {
    id: "comp_boots_sequential_20",
    name: "Pressotherapie sequentielle standard (20 min)",
    family: "compression",
    equipment: ["compression_boots"],
    zones: ["legs", "calves", "quadriceps"],
    durationSec: 1200,
    phases: [
      { label: "Montee en pression progressive (50-70 mmHg)", sec: 120 },
      { label: "Cycle sequentiel distal -> proximal", sec: 1020 },
      { label: "Degonflage complet & repos 1 min", sec: 60 },
    ],
    intensity: "very_low",
    contraindications: [
      "tvp_history",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: [],
    svg: "comp_boots_seq",
    cues: [
      "Aucune douleur ni fourmillement dans les orteils ; ajuster la pression entre 50 et 70 mmHg (Sands et al., 2015).",
    ],
  },
  {
    id: "comp_boots_gentle_drainage",
    name: "Pressotherapie drainage leger (40-50 mmHg, 15 min)",
    family: "compression",
    equipment: ["compression_boots"],
    zones: ["legs", "ankle", "calves"],
    durationSec: 900,
    phases: [
      { label: "Drainage doux basse pression (40-50 mmHg)", sec: 900 },
    ],
    intensity: "very_low",
    contraindications: [
      "tvp_history",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: [],
    svg: "comp_boots_gentle",
    cues: [
      "Adapte en veille de competition ou en cas de HRV basse pour alleger les jambes sans fatigue.",
    ],
  },
  {
    id: "comp_boots_pulsed_hiit",
    name: "Pressotherapie mode pulse post-HIIT (70-90 mmHg, 25 min)",
    family: "compression",
    equipment: ["compression_boots"],
    zones: ["legs", "quadriceps", "hamstrings"],
    durationSec: 1500,
    phases: [
      { label: "Chauffe sequentielle 60 mmHg", sec: 180 },
      { label: "Mode pulse 75-90 mmHg", sec: 1260 },
      { label: "Retour pression nulle", sec: 60 },
    ],
    intensity: "low",
    contraindications: [
      "tvp_history",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: [],
    svg: "comp_boots_pulsed",
    cues: [
      "Reduction subjective de la fatigue musculaire post-cyclisme intense (Hoffman et al., 2016).",
    ],
  },
  {
    id: "comp_boots_express_12",
    name: "Pressotherapie express jambes lourdes (12 min)",
    family: "compression",
    equipment: ["compression_boots"],
    zones: ["legs", "calves"],
    durationSec: 720,
    phases: [
      { label: "Cycle sequentiel rapide 55-65 mmHg", sec: 720 },
    ],
    intensity: "very_low",
    contraindications: [
      "tvp_history",
      "severe_varicose_veins",
      "lymphedema_av_fistula",
      "acute_fever_infection",
      "acute_trauma_open_wound",
    ],
    conflicts: [],
    svg: "comp_boots_express",
    cues: [
      "Jambes legerement surelevees sur coussin si possible.",
    ],
  },

  // ---------------------------------------------------------------------------
  // FAMILLE 8 : RETOUR AU CALME RESPIRATOIRE (4 exercices + deep link webbreath)
  // ---------------------------------------------------------------------------
  {
    id: "breath_coherence_55",
    name: "Coherence cardiaque 5.5 cycles/min (lien WebBreath)",
    family: "breath",
    equipment: [],
    zones: ["autonomic", "diaphragm", "hrv"],
    durationSec: 330,
    phases: [
      { label: "Inspir nasal doux 5.5 s / Expir lent 5.5 s", sec: 11, repeat: 30 },
    ],
    intensity: "very_low",
    contraindications: [],
    conflicts: [],
    svg: "breath_coherence",
    deepLink: "../webbreath/index.html?preset=coherence_55",
    cues: [
      "Ouvrir dans WebBreath pour le pacer visuel/sonore synchronise.",
      "Maximise l'arythmie sinusale respiratoire et le tonus vagal (Lehrer & Gevirtz, 2014).",
    ],
  },
  {
    id: "breath_vagal_4_8",
    name: "Expiration prolongee 4-8 (frein vagal — WebBreath)",
    family: "breath",
    equipment: [],
    zones: ["autonomic", "hrv", "sleep"],
    durationSec: 360,
    phases: [
      { label: "Inspir nasal 4 s + Expir fluide 8 s (ratio 1:2)", sec: 12, repeat: 30 },
    ],
    intensity: "very_low",
    contraindications: [],
    conflicts: [],
    svg: "breath_vagal",
    deepLink: "../webbreath/index.html?preset=vagal_4_8",
    cues: [
      "Ouvrir dans WebBreath pour le guidage continu.",
      "Ne jamais forcer l'expiration ; allonger sans tension laryngee.",
    ],
  },
  {
    id: "breath_nsdr_body_scan",
    name: "NSDR / Relaxation parasympathique profonde (10 min — WebBreath)",
    family: "breath",
    equipment: [],
    zones: ["autonomic", "cns", "sleep"],
    durationSec: 600,
    phases: [
      { label: "Soupir physiologique (double inspir + long expir) x 5", sec: 60 },
      { label: "Scan corporel descendant & respiration spontanee lente", sec: 540 },
    ],
    intensity: "very_low",
    contraindications: [],
    conflicts: [],
    svg: "breath_nsdr",
    deepLink: "../webbreath/index.html?preset=nsdr_recovery",
    cues: [
      "Ouvrir dans WebBreath (mode NSDR).",
      "Utile apres seance intense, dette de sommeil ou HRV basse (Balban et al., 2023).",
    ],
  },
  {
    id: "breath_nasal_downregulate",
    name: "Retour au calme nasal post-effort (5 min — WebBreath)",
    family: "breath",
    equipment: [],
    zones: ["respiratory", "autonomic"],
    durationSec: 300,
    phases: [
      { label: "Transition bouche fermee, respiration diaphragmatique lente", sec: 300 },
    ],
    intensity: "very_low",
    contraindications: [],
    conflicts: [],
    svg: "breath_nasal",
    deepLink: "../webbreath/index.html?preset=nasal_downregulate",
    cues: [
      "Ouvrir dans WebBreath pour abaisser la FC post-HIIT avant de quitter la seance.",
    ],
  },
];

// =============================================================================
// 4. PROTOCOLES PREDEFINIS (8 PROTOCOLES SCIENTIFIQUES)
// =============================================================================

const exerciseDurationLookup = new Map(RAW_EXERCISES.map((ex) => [ex.id, ex.durationSec]));

function computeProtocolDuration(ids) {
  return ids.reduce((total, id) => total + (exerciseDurationLookup.get(id) ?? 0), 0);
}

const RAW_PROTOCOLS = [
  // Peake et al., 2017 ; Dupuy et al., 2018 : priorité clairance, retour vagal, froid autorisé si >4h hors muscu
  {
    id: "post_hiit_velo",
    name: "Post-HIIT velo",
    objective: "Accelere le retour parasympathique, reduit les DOMS et restaure le confort musculaire des membres inferieurs.",
    reference: "Peake et al., 2017 ; Dupuy et al., 2018 ; Sperlich et al., 2017",
    targetStates: ["post_endurance_hiit", "high_lactate", "legs_heavy"],
    forbiddenConflicts: [],
    exerciseIds: [
      "breath_nasal_downregulate",
      "hyperoxia_post_hiit_15",
      "stretch_psoas_couch_static",
      "stretch_quad_strap_prone",
      "comp_boots_pulsed_hiit",
      "thermal_cold_plunge_legs",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "breath_nasal_downregulate",
      "hyperoxia_post_hiit_15",
      "stretch_psoas_couch_static",
      "stretch_quad_strap_prone",
      "comp_boots_pulsed_hiit",
      "thermal_cold_plunge_legs",
    ]),
    notes:
      "Si le HIIT velo a ete precede d'une seance de musculation dans les 4 h, le moteur retire automatiquement l'immersion froide (Roberts et al., 2015).",
  },

  // Roberts et al., 2015 ; Figueiredo et al., 2016 : interdiction absolue de bain froid <4h pour preserver mTORC1 et l'hypertrophie
  {
    id: "post_muscu_sans_froid",
    name: "Post-musculation (sans froid)",
    objective: "Preserve la signalisation anabolique (mTORC1) et la synthese proteique tout en levant les tensions rachidiennes et fasciales.",
    reference: "Roberts et al., 2015 ; Figueiredo et al., 2016 ; Patterson et al., 2019 (principes BFR en %LOP/mmHg)",
    targetStates: ["post_strength", "hypertrophy_focus"],
    forbiddenConflicts: ["strength_lt_4h"],
    exerciseIds: [
      "breath_coherence_55",
      "bolster_lumbar_legs_elevated",
      "kaatsu_cycle_legs_recovery_soft",
      "stretch_pec_doorway_pnf",
      "stretch_hamstring_strap_static",
      "sm_roller_thoracic",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "breath_coherence_55",
      "bolster_lumbar_legs_elevated",
      "kaatsu_cycle_legs_recovery_soft",
      "stretch_pec_doorway_pnf",
      "stretch_hamstring_strap_static",
      "sm_roller_thoracic",
    ]),
    notes:
      "Aucun bain froid ni contraste froid inclus afin de ne pas emousser les adaptations structurales dans la fenetre des 4 h post-muscu (Roberts et al., 2015).",
  },

  // Kellmann et al., 2018 ; Patterson et al., 2019 : perfusion tissulaire douce et mobilite globale sans dette nerveuse
  {
    id: "repos_actif",
    name: "Journee de repos actif",
    objective: "Stimule la perfusion microvasculaire, la mobilite articulaire et l'adaptation mitochondriale sans charge mecanique.",
    reference: "Kellmann et al., 2018 ; Patterson et al., 2019 (principes BFR en %LOP/mmHg) ; Serebrovskaya & Xi, 2016",
    targetStates: ["rest_day", "moderate_fatigue"],
    forbiddenConflicts: [],
    exerciseIds: [
      "dyn_world_greatest_flow",
      "mob_hip_90_90_switches",
      "kaatsu_walk_light",
      "ihht_standard_5_3",
      "sm_ball_plantar_fascia",
      "thermal_sauna_endurance",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "dyn_world_greatest_flow",
      "mob_hip_90_90_switches",
      "kaatsu_walk_light",
      "ihht_standard_5_3",
      "sm_ball_plantar_fascia",
      "thermal_sauna_endurance",
    ]),
    notes:
      "L'IHHT impose le port continu de l'oxymetre avec bascule de masque et arret a SpO2 <= 82 %.",
  },

  // Plews et al., 2013 ; Lehrer & Gevirtz, 2014 : priorite absolue au tonus vagal, zero contrainte stressante
  {
    id: "hrv_basse",
    name: "HRV basse / fatigue autonomique",
    objective: "Restaurer l'equilibre sympatho-vagal via respiration lente, decompression passive et exposition hypoxique tres moderee ou absente.",
    reference: "Plews et al., 2013 ; Lehrer & Gevirtz, 2014 ; Balban et al., 2023",
    targetStates: ["low_hrv", "poor_sleep", "high_atl"],
    forbiddenConflicts: ["high_fatigue_cns"],
    exerciseIds: [
      "breath_vagal_4_8",
      "breath_nsdr_body_scan",
      "bolster_t6t7_decompression",
      "bolster_diaphragm_release",
      "comp_boots_gentle_drainage",
      "ihht_gentle_hrv_4_4",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "breath_vagal_4_8",
      "breath_nsdr_body_scan",
      "bolster_t6t7_decompression",
      "bolster_diaphragm_release",
      "comp_boots_gentle_drainage",
      "ihht_gentle_hrv_4_4",
    ]),
    notes:
      "Si z-score HRV < -2.0, privilegier uniquement respiration + bolster + pressotherapie douce et reporter l'IHHT.",
  },

  // Mujika & Padilla, 2003 ; Bosquet et al., 2007 : fraicheur neuromusculaire sans etirements statiques longs fatigants
  {
    id: "veille_competition",
    name: "Veille de competition (affutage)",
    objective: "Maintenir le tonus et l'aisance articulaire sans relachement excessif de la raideur elastique ni fatigue thermique.",
    reference: "Mujika & Padilla, 2003 ; Bosquet et al., 2007 ; Behm et al., 2016",
    targetStates: ["pre_competition", "taper"],
    forbiddenConflicts: [],
    exerciseIds: [
      "mob_thoracic_open_book",
      "mob_ankle_wblt_lunge",
      "sm_ball_plantar_fascia",
      "comp_boots_express_12",
      "hyperoxia_express_10",
      "breath_coherence_55",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "mob_thoracic_open_book",
      "mob_ankle_wblt_lunge",
      "sm_ball_plantar_fascia",
      "comp_boots_express_12",
      "hyperoxia_express_10",
      "breath_coherence_55",
    ]),
    notes:
      "Evite les etirements statiques prolonges (> 60 s/muscle) et le sauna long susceptibles d'induire une hypotonie ou deshydratation la veille de l'epreuve.",
  },

  // Halson, 2014 ; Kräuchi, 2007 : baisse thermique nocturne et activation parasympathique pre-sommeil
  {
    id: "soir_sommeil",
    name: "Soir & preparation au sommeil",
    objective: "Abaisser l'eveil cortical et faciliter le refroidissement central avant l'endormissement.",
    reference: "Halson, 2014 ; Kräuchi, 2007 ; Balban et al., 2023",
    targetStates: ["evening", "sleep_prep"],
    forbiddenConflicts: [],
    exerciseIds: [
      "thermal_sauna_evening_short",
      "bolster_lumbar_legs_elevated",
      "sm_ball_suboccipital",
      "stretch_lat_child_pose",
      "breath_vagal_4_8",
      "breath_nsdr_body_scan",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "thermal_sauna_evening_short",
      "bolster_lumbar_legs_elevated",
      "sm_ball_suboccipital",
      "stretch_lat_child_pose",
      "breath_vagal_4_8",
      "breath_nsdr_body_scan",
    ]),
    notes:
      "Si moins de 90 min avant le coucher, omettre le sauna et conserver uniquement la sequence bolster + balle sous-occipitale + respiration.",
  },

  // Konor et al., 2012 ; Terada et al., 2013 : dorsiflexion WBLT, glissement talo-crural et chaine plantaire
  {
    id: "cheville",
    name: "Mobilite & recuperation cheville (WBLT)",
    objective: "Restaurer la dorsiflexion talo-crurale, liberer le soleaire et drainer l'articulation tibio-tarsienne.",
    reference: "Konor et al., 2012 ; Terada et al., 2013 ; Grieve et al., 2015",
    targetStates: ["ankle_stiffness", "post_run", "wblt_deficit"],
    forbiddenConflicts: [],
    exerciseIds: [
      "sm_ball_plantar_fascia",
      "sm_roller_calves",
      "mob_ankle_band_talocrural",
      "mob_ankle_wblt_lunge",
      "stretch_calf_gastroc_soleus",
      "kaatsu_ankle_mobility_cycles",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "sm_ball_plantar_fascia",
      "sm_roller_calves",
      "mob_ankle_band_talocrural",
      "mob_ankle_wblt_lunge",
      "stretch_calf_gastroc_soleus",
      "kaatsu_ankle_mobility_cycles",
    ]),
    notes:
      "Mesurer la dorsiflexion avant/apres dans l'application compagnon wblt-ankle-pwa pour quantifier le gain en cm.",
  },

  // Lau et al., 2011 ; pratique kiné & Jacquier : ouverture T6-T7, diaphragme et ceinture scapulaire
  {
    id: "decompression_dorsale",
    name: "Decompression dorsale T6-T7 & ouverture thoracique",
    objective: "Corriger l'enroulement thoracique, liberer la charniere T6-T7 et ameliorer la mecanique costo-diaphragmatique.",
    reference: "Lau et al., 2011 ; Nachemson, 1981 ; Pratique kinesitherapie Jacquier",
    targetStates: ["thoracic_stiffness", "post_aero_cycling", "desk_posture"],
    forbiddenConflicts: [],
    exerciseIds: [
      "sm_roller_thoracic",
      "bolster_t6t7_decompression",
      "bolster_thoracic_longitudinal",
      "bolster_diaphragm_release",
      "mob_thoracic_open_book",
      "stretch_pec_doorway_pnf",
    ],
    estimatedDurationSec: computeProtocolDuration([
      "sm_roller_thoracic",
      "bolster_t6t7_decompression",
      "bolster_thoracic_longitudinal",
      "bolster_diaphragm_release",
      "mob_thoracic_open_book",
      "stretch_pec_doorway_pnf",
    ]),
    notes:
      "Complementaire de reset-t6t7-pwa ; sortir lateralement du bolster en fin de posture.",
  },
];

// =============================================================================
// EXPORTS IMMUABLES & INDEXES DE CONSULTATION
// =============================================================================

export const FAMILIES = Object.freeze([
  "stretching",
  "bolster_jacquier",
  "self_massage",
  "kaatsu",
  "hyperoxia_ihht",
  "thermal",
  "compression",
  "breath",
]);

export const CONTRAINDICATIONS = deepFreeze(RAW_CONTRAINDICATIONS);
export const EQUIPMENT = deepFreeze(RAW_EQUIPMENT);
export const EXERCISES = deepFreeze(RAW_EXERCISES);
export const PROTOCOLS = deepFreeze(RAW_PROTOCOLS);

export const EQUIPMENT_BY_ID = Object.freeze(
  Object.fromEntries(EQUIPMENT.map((item) => [item.id, item])),
);
export const EXERCISES_BY_ID = Object.freeze(
  Object.fromEntries(EXERCISES.map((item) => [item.id, item])),
);
export const PROTOCOLS_BY_ID = Object.freeze(
  Object.fromEntries(PROTOCOLS.map((item) => [item.id, item])),
);
export const CONTRAINDICATIONS_BY_ID = Object.freeze(
  Object.fromEntries(CONTRAINDICATIONS.map((item) => [item.id, item])),
);
