require("dotenv").config();

const { Telegraf } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");

const botToken = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!botToken) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

if (!supabaseUrl) {
  console.error("Missing SUPABASE_URL");
  process.exit(1);
}

if (!supabaseServiceRoleKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const bot = new Telegraf(botToken);
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const supplements = [
  {
    id: "iron",
    displayName: "Iron",
    selfCooldownMinutes: 1440,
  },
  {
    id: "zinc",
    displayName: "Zinc",
    selfCooldownMinutes: 1440,
  },
  {
    id: "vitamin_d",
    displayName: "Vitamin D",
    selfCooldownMinutes: 1440,
  },
  {
    id: "magnesium",
    displayName: "Magnesium",
    selfCooldownMinutes: 1440,
  },
];

const waitMinutesByPreviousThenNext = {
  // Vitamin D has no pair-wait rules — only the 24-hour self-cooldown applies.

  iron: {
    zinc: 120,
    magnesium: 1,
  },

  zinc: {
    iron: 60,
    magnesium: 30,
  },

  magnesium: {
    iron: 30,
    zinc: 30,
  },
};

const consumedComments = [
  "Very good.",
  "Marked with grace.",
  "Noted.",
  "The record is kept.",
  "Good. We continue.",
];

bot.start(async (context) => {
  await context.reply("Transmuting inside the abyss, listening.");
});

bot.command("summon", async (context) => {
  await askWhichSupplementWasConsumed(context);
});

bot.on("text", async (context) => {
  const userMessage = context.message.text.trim().toLowerCase();

  const userSummonedBot =
    userMessage === "summon" ||
    userMessage === "begin" ||
    userMessage === "wake" ||
    userMessage === "attend";

  if (userSummonedBot) {
    await askWhichSupplementWasConsumed(context);
    return;
  }

  await context.reply("Listening, sounds are fading, indecypherable.");
});

async function askWhichSupplementWasConsumed(context) {
  const telegramChatId = String(context.chat.id);
  const consumedSupplementButtons = await getSupplementChoiceButtons({
    telegramChatId,
    actionPrefix: "consumed",
  });

  const everySupplementIsOnCooldown = consumedSupplementButtons.length === 0;

  if (everySupplementIsOnCooldown) {
    const scheduledReminder = await scheduleReminderForFirstSupplementOffCooldown(
      telegramChatId
    );

    await context.reply(getAllOnCooldownMessage(scheduledReminder));
    return;
  }

  await context.reply("Please pick a vitamin out of the selection.", {
    reply_markup: {
      inline_keyboard: consumedSupplementButtons,
    },
  });
}

bot.action(/^consumed:(.+)$/, async (context) => {
  const consumedSupplementId = context.match[1];
  const consumedSupplement = getSupplementById(consumedSupplementId);

  if (!consumedSupplement) {
    await context.answerCbQuery("Unknown supplement");
    return;
  }

  const telegramChatId = String(context.chat.id);

  const supplementIsOnCooldown = await isSupplementOnCooldown({
    telegramChatId,
    supplementId: consumedSupplementId,
  });

  if (supplementIsOnCooldown) {
    await context.answerCbQuery("Still on cooldown");
    return;
  }
  const consumedAt = new Date().toISOString();

  const consumedLogWasSaved = await saveConsumedSupplementLog({
    telegramChatId,
    supplementId: consumedSupplementId,
    consumedAt,
  });

  if (!consumedLogWasSaved) {
    await context.answerCbQuery("Could not save");
    await context.reply("I could not save that. Check logs.");
    return;
  }

  const consumedComment = getRandomConsumedComment();

  await context.answerCbQuery(`Consumed ${consumedSupplement.displayName}`);

  await context.editMessageText(
    `User has consumed ${consumedSupplement.displayName}.`
  );

  const nextSupplementButtons = await getSupplementChoiceButtons({
    telegramChatId,
    actionPrefix: "next",
  });

  const everyOtherSupplementIsOnCooldown = nextSupplementButtons.length === 0;

  if (everyOtherSupplementIsOnCooldown) {
    const scheduledReminder = await scheduleReminderForFirstSupplementOffCooldown(
      telegramChatId
    );

    await context.reply(
      `${consumedComment}\n\n${getAllOnCooldownMessage(scheduledReminder)}`
    );
    return;
  }

  await context.reply(
    `${consumedComment}\n\nPlease pick the next vitamin for consumption.`,
    {
      reply_markup: {
        inline_keyboard: nextSupplementButtons,
      },
    }
  );
});

async function getSupplementChoiceButtons({ telegramChatId, actionPrefix }) {
  const availableSupplements = await getSupplementsNotOnCooldown(telegramChatId);

  const supplementButtons = [];

  for (const supplement of availableSupplements) {
    supplementButtons.push([
      {
        text: supplement.displayName,
        callback_data: `${actionPrefix}:${supplement.id}`,
      },
    ]);
  }

  return supplementButtons;
}

bot.action(/^next:(.+)$/, async (context) => {
  const nextSupplementId = context.match[1];
  const nextSupplement = getSupplementById(nextSupplementId);

  if (!nextSupplement) {
    await context.answerCbQuery("Unknown supplement");
    return;
  }

  const telegramChatId = String(context.chat.id);

  const supplementIsOnCooldown = await isSupplementOnCooldown({
    telegramChatId,
    supplementId: nextSupplementId,
  });

  if (supplementIsOnCooldown) {
    await context.answerCbQuery("Still on cooldown");
    return;
  }

  const lastConsumedLog = await getLastConsumedSupplementLog(telegramChatId);

  if (!lastConsumedLog) {
    await context.answerCbQuery("No previous vitamin");
    await context.reply("I do not know what was consumed last. Summon me again.");
    return;
  }

  const nextEligibleAt = await getNextEligibleTime({
    telegramChatId,
    previousSupplementId: lastConsumedLog.supplement_id,
    nextSupplementId,
    previousConsumedAt: lastConsumedLog.taken_at,
  });

  const loopStateWasSaved = await saveLoopState({
    telegramChatId,
    nextSupplementId,
    nextEligibleAt: nextEligibleAt.toISOString(),
  });

  if (!loopStateWasSaved) {
    await context.answerCbQuery("Could not save");
    await context.reply("I could not save the next timer. Check logs.");
    return;
  }

  const previousSupplement = getSupplementById(lastConsumedLog.supplement_id);

  const pairWaitMinutes = getWaitMinutesBetweenSupplements({
    previousSupplementId: lastConsumedLog.supplement_id,
    nextSupplementId,
  });

  const ownCooldownEligibleAt = await getOwnCooldownEligibleTime({
    telegramChatId,
    supplementId: nextSupplementId,
  });

  await context.answerCbQuery(`${nextSupplement.displayName} selected`);

  await context.editMessageText(
    [
      `Next selected: ${nextSupplement.displayName}.`,
      "",
      `Previous consumed: ${previousSupplement.displayName}.`,
      `Pair wait: ${pairWaitMinutes} minutes.`,
      `Own cooldown clears at: ${formatTimeForUser(ownCooldownEligibleAt)}.`,
      `I will call you at: ${formatTimeForUser(nextEligibleAt)}.`,
    ].join("\n")
  );
});

async function getNextEligibleTime({
  telegramChatId,
  previousSupplementId,
  nextSupplementId,
  previousConsumedAt,
}) {
  const pairWaitEligibleAt = getPairWaitEligibleTime({
    previousSupplementId,
    nextSupplementId,
    previousConsumedAt,
  });

  const ownCooldownEligibleAt = await getOwnCooldownEligibleTime({
    telegramChatId,
    supplementId: nextSupplementId,
  });

  const ownCooldownEndsLater = ownCooldownEligibleAt > pairWaitEligibleAt;

  if (ownCooldownEndsLater) {
    return ownCooldownEligibleAt;
  }

  return pairWaitEligibleAt;
}

function getPairWaitEligibleTime({
  previousSupplementId,
  nextSupplementId,
  previousConsumedAt,
}) {
  const waitMinutes = getWaitMinutesBetweenSupplements({
    previousSupplementId,
    nextSupplementId,
  });

  const previousConsumedTime = new Date(previousConsumedAt).getTime();
  const waitTimeInMilliseconds = waitMinutes * 60 * 1000;
  const eligibleTime = previousConsumedTime + waitTimeInMilliseconds;

  return new Date(eligibleTime);
}

function getWaitMinutesBetweenSupplements({
  previousSupplementId,
  nextSupplementId,
}) {
  const waitTimesAfterPreviousSupplement =
    waitMinutesByPreviousThenNext[previousSupplementId];

  const noSpecificRulesForPreviousSupplement =
    waitTimesAfterPreviousSupplement == null;

  if (noSpecificRulesForPreviousSupplement) {
    return 0;
  }

  const waitMinutes = waitTimesAfterPreviousSupplement[nextSupplementId];

  const noSpecificRuleForNextSupplement = waitMinutes == null;

  if (noSpecificRuleForNextSupplement) {
    return 0;
  }

  return waitMinutes;
}

async function getSupplementsNotOnCooldown(telegramChatId) {
  const availableSupplements = [];

  for (const supplement of supplements) {
    const supplementIsOnCooldown = await isSupplementOnCooldown({
      telegramChatId,
      supplementId: supplement.id,
    });

    if (!supplementIsOnCooldown) {
      availableSupplements.push(supplement);
    }
  }

  return availableSupplements;
}

async function isSupplementOnCooldown({ telegramChatId, supplementId }) {
  const supplement = getSupplementById(supplementId);

  if (!supplement) {
    return true;
  }

  const lastConsumedLog = await getLastConsumedLogForSupplement({
    telegramChatId,
    supplementId,
  });

  if (!lastConsumedLog) {
    return false;
  }

  const cooldownEndsAt = getSupplementCooldownEndTime({
    supplement,
    consumedAt: lastConsumedLog.taken_at,
  });

  const cooldownStillActive = cooldownEndsAt > new Date();

  return cooldownStillActive;
}

async function getOwnCooldownEligibleTime({ telegramChatId, supplementId }) {
  const supplement = getSupplementById(supplementId);

  if (!supplement) {
    return new Date();
  }

  const lastConsumedLog = await getLastConsumedLogForSupplement({
    telegramChatId,
    supplementId,
  });

  if (!lastConsumedLog) {
    return new Date();
  }

  return getSupplementCooldownEndTime({
    supplement,
    consumedAt: lastConsumedLog.taken_at,
  });
}

function getSupplementCooldownEndTime({ supplement, consumedAt }) {
  const consumedTime = new Date(consumedAt).getTime();
  const cooldownInMilliseconds = supplement.selfCooldownMinutes * 60 * 1000;
  const cooldownEndTime = consumedTime + cooldownInMilliseconds;

  return new Date(cooldownEndTime);
}

async function getFirstSupplementOffCooldown(telegramChatId) {
  let earliestEligibleAt = null;
  let earliestSupplementId = null;

  for (const supplement of supplements) {
    const lastConsumedLog = await getLastConsumedLogForSupplement({
      telegramChatId,
      supplementId: supplement.id,
    });

    if (!lastConsumedLog) {
      continue;
    }

    const cooldownEndsAt = getSupplementCooldownEndTime({
      supplement,
      consumedAt: lastConsumedLog.taken_at,
    });

    const cooldownStillActive = cooldownEndsAt > new Date();

    if (!cooldownStillActive) {
      continue;
    }

    const noEarliestYet = earliestEligibleAt == null;
    const thisOneIsEarlier = cooldownEndsAt < earliestEligibleAt;

    if (noEarliestYet || thisOneIsEarlier) {
      earliestEligibleAt = cooldownEndsAt;
      earliestSupplementId = supplement.id;
    }
  }

  if (earliestSupplementId == null) {
    return null;
  }

  return {
    supplementId: earliestSupplementId,
    eligibleAt: earliestEligibleAt,
  };
}

async function scheduleReminderForFirstSupplementOffCooldown(telegramChatId) {
  const firstOffCooldown = await getFirstSupplementOffCooldown(telegramChatId);

  if (!firstOffCooldown) {
    return null;
  }

  const loopStateWasSaved = await saveLoopState({
    telegramChatId,
    nextSupplementId: firstOffCooldown.supplementId,
    nextEligibleAt: firstOffCooldown.eligibleAt.toISOString(),
  });

  if (!loopStateWasSaved) {
    return null;
  }

  const supplement = getSupplementById(firstOffCooldown.supplementId);

  return {
    supplement,
    eligibleAt: firstOffCooldown.eligibleAt,
  };
}

function getAllOnCooldownMessage(scheduledReminder) {
  if (!scheduledReminder) {
    return "Every vitamin is still on cooldown. I could not schedule a reminder. Check logs.";
  }

  return [
    "Every vitamin is still on cooldown.",
    `I will call you when ${scheduledReminder.supplement.displayName} is ready.`,
    `That is at: ${formatTimeForUser(scheduledReminder.eligibleAt)}.`,
  ].join("\n");
}

async function checkForEligibleSupplements() {
  const now = new Date().toISOString();

  const { data: eligibleLoopStates, error } = await supabase
    .from("loop_states")
    .select("*")
    .lte("next_eligible_at", now)
    .is("reminder_sent_at", null);

  if (error) {
    console.error("Failed to check eligible supplements:", error);
    return;
  }

  for (const loopState of eligibleLoopStates) {
    await sendEligibleSupplementReminder(loopState);
  }
}

async function sendEligibleSupplementReminder(loopState) {
  const telegramChatId = loopState.telegram_chat_id;
  const nextSupplement = getSupplementById(loopState.next_supplement_id);

  if (!nextSupplement) {
    console.error("Unknown next supplement:", loopState.next_supplement_id);
    return;
  }

  await bot.telegram.sendMessage(
    telegramChatId,
    [
      `${nextSupplement.displayName} is eligible now.`,
      "",
      "Please consume it, then mark it below.",
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `Consumed ${nextSupplement.displayName}`,
              callback_data: `consumed:${nextSupplement.id}`,
            },
          ],
          [
            {
              text: "Choose something else",
              callback_data: "choose_next_again",
            },
          ],
        ],
      },
    }
  );

  await markReminderAsSent(telegramChatId);
}

bot.action("choose_next_again", async (context) => {
  await context.answerCbQuery("Choose next");

  const telegramChatId = String(context.chat.id);
  const nextSupplementButtons = await getSupplementChoiceButtons({
    telegramChatId,
    actionPrefix: "next",
  });

  const everySupplementIsOnCooldown = nextSupplementButtons.length === 0;

  if (everySupplementIsOnCooldown) {
    const scheduledReminder = await scheduleReminderForFirstSupplementOffCooldown(
      telegramChatId
    );

    await context.editMessageText(getAllOnCooldownMessage(scheduledReminder));
    return;
  }

  await context.editMessageText("Please pick the next vitamin for consumption.", {
    reply_markup: {
      inline_keyboard: nextSupplementButtons,
    },
  });
});

async function saveConsumedSupplementLog({
  telegramChatId,
  supplementId,
  consumedAt,
}) {
  const { error } = await supabase.from("taken_logs").insert({
    telegram_chat_id: telegramChatId,
    supplement_id: supplementId,
    taken_at: consumedAt,
  });

  if (error) {
    console.error("Failed to save consumed supplement log:", error);
    return false;
  }

  return true;
}

async function getLastConsumedSupplementLog(telegramChatId) {
  const { data, error } = await supabase
    .from("taken_logs")
    .select("*")
    .eq("telegram_chat_id", telegramChatId)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Failed to get last consumed supplement log:", error);
    return null;
  }

  return data;
}

async function getLastConsumedLogForSupplement({ telegramChatId, supplementId }) {
  const { data, error } = await supabase
    .from("taken_logs")
    .select("*")
    .eq("telegram_chat_id", telegramChatId)
    .eq("supplement_id", supplementId)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Failed to get last consumed log for supplement:", error);
    return null;
  }

  return data;
}

async function saveLoopState({
  telegramChatId,
  nextSupplementId,
  nextEligibleAt,
}) {
  const now = new Date().toISOString();

  const { error } = await supabase.from("loop_states").upsert({
    telegram_chat_id: telegramChatId,
    next_supplement_id: nextSupplementId,
    next_eligible_at: nextEligibleAt,
    reminder_sent_at: null,
    updated_at: now,
  });

  if (error) {
    console.error("Failed to save loop state:", error);
    return false;
  }

  return true;
}

async function markReminderAsSent(telegramChatId) {
  const reminderSentAt = new Date().toISOString();

  const { error } = await supabase
    .from("loop_states")
    .update({
      reminder_sent_at: reminderSentAt,
      updated_at: reminderSentAt,
    })
    .eq("telegram_chat_id", telegramChatId);

  if (error) {
    console.error("Failed to mark reminder as sent:", error);
  }
}

function getSupplementById(supplementId) {
  for (const supplement of supplements) {
    const isSameSupplement = supplement.id === supplementId;

    if (isSameSupplement) {
      return supplement;
    }
  }

  return null;
}

function getRandomConsumedComment() {
  const randomIndex = Math.floor(Math.random() * consumedComments.length);

  return consumedComments[randomIndex];
}

function formatTimeForUser(dateOrIsoTime) {
  const date = new Date(dateOrIsoTime);

  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "short",
    timeStyle: "short",
  });
}

bot.catch((error) => {
  console.error("Bot error:", error);
});

bot.launch();

setInterval(checkForEligibleSupplements, 60 * 1000);

console.log("Bot running");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));