require('dotenv').config();
const CONFIG = require('../../config/config');
var azure = require('azure-storage');

//We want to load keys and configurable parameters from the environment variables. This
//allows for flexible re-deployment in the azure container instances
updateConfigFromEnv();

//Setup the azure storage tables
var missedTable = null;
var executedTable = null;
var potentialTable = null;
setupAzureTables();

const logger = require('./Loggers');
const Util = require('./Util');
const si = require('systeminformation');
const BinanceApi = require('./BinanceApi');
const MarketCache = require('./MarketCache');
const HUD = require('./HUD');
const ArbitrageExecution = require('./ArbitrageExecution');
const CalculationNode = require('./CalculationNode');
const SpeedTest = require('./SpeedTest');

let recentCalculationTimes = [];

// Helps identify application startup
logger.binance.info(logger.LINE);
logger.execution.info(logger.LINE);
logger.performance.info(logger.LINE);

if (CONFIG.TRADING.ENABLED) console.log(`WARNING! Order execution is enabled!\n`);

process.on('uncaughtException', handleError);

function setupAzureTables() {

    missedTable = azure.createTableService();
    missedTable.createTableIfNotExists(process.env.AZURE_MISSED_TABLE, function (error, result, response) {
        if (!error) {
            console.log("Azure table ready: " + process.env.AZURE_MISSED_TABLE);
        } else {
            console.error("Could not setup the azure table: " + process.env.AZURE_MISSED_TABLE);
        }
    });

    executedTable = azure.createTableService();
    executedTable.createTableIfNotExists(process.env.AZURE_EXECUTED_TABLE, function (error, result, response) {
        if (!error) {
            console.log("Azure table ready: " + process.env.AZURE_EXECUTED_TABLE);
        } else {
            console.error("Could not setup the azure table: " + process.env.AZURE_EXECUTED_TABLE);
        }
    });

    potentialTable = azure.createTableService();
    potentialTable.createTableIfNotExists(process.env.AZURE_POTENTIAL_TABLE, function (error, result, response) {
        if (!error) {
            console.log("Azure table ready: " + process.env.AZURE_POTENTIAL_TABLE);
        } else {
            console.error("Could not setup the azure table: " + process.env.AZURE_POTENTIAL_TABLE);
        }
    });
}

function updateConfigFromEnv() {

    //Update the config from the environment variables if they exit 
    if (process.env.API_KEY && process.env.API_KEY.length >= 1) CONFIG.KEYS.API = process.env.API_KEY;
    if (process.env.API_SECRET && process.env.API_SECRET.length >= 1) CONFIG.KEYS.SECRET = process.env.API_SECRET;
    if (process.env.INVESTMENT_BASE && process.env.INVESTMENT_BASE.length >= 1) CONFIG.INVESTMENT.BASE = process.env.INVESTMENT_BASE;
    if (process.env.INVESTMENT_MIN && process.env.INVESTMENT_MIN.length >= 1) CONFIG.INVESTMENT.MIN = parseFloat(process.env.INVESTMENT_MIN);
    if (process.env.INVESTMENT_MAX && process.env.INVESTMENT_MAX.length >= 1) CONFIG.INVESTMENT.MAX = parseFloat(process.env.INVESTMENT_MAX);
    if (process.env.INVESTMENT_STEP && process.env.INVESTMENT_STEP.length >= 1) CONFIG.INVESTMENT.STEP = parseFloat(process.env.INVESTMENT_STEP);
    if (process.env.TRADING_ENABLED && process.env.TRADING_ENABLED.length >= 1) CONFIG.TRADING.ENABLED = (process.env.TRADING_ENABLED == "true");
    if (process.env.TRADING_EXECUTION_CAP && process.env.TRADING_EXECUTION_CAP.length >= 1) CONFIG.TRADING.EXECUTION_CAP = parseInt(process.env.TRADING_EXECUTION_CAP);
    if (process.env.TRADING_TAKER_FEE && process.env.TRADING_TAKER_FEE.length >= 1) CONFIG.TRADING.TAKER_FEE = parseFloat(process.env.TRADING_TAKER_FEE);
    if (process.env.TRADING_PROFIT_THRESHOLD && process.env.TRADING_PROFIT_THRESHOLD.length >= 1) CONFIG.TRADING.PROFIT_THRESHOLD = parseFloat(process.env.TRADING_PROFIT_THRESHOLD);
    if (process.env.TRADING_AGE_THRESHOLD && process.env.TRADING_AGE_THRESHOLD.length >= 1) CONFIG.TRADING.AGE_THRESHOLD = parseInt(process.env.TRADING_AGE_THRESHOLD);
    if (process.env.LOG_LEVEL && process.env.LOG_LEVEL.length >= 1) CONFIG.LOG.LEVEL = process.env.LOG_LEVEL;
    if (process.env.DEPTH_SIZE && process.env.DEPTH_SIZE.length >= 1) CONFIG.DEPTH.SIZE = parseInt(process.env.DEPTH_SIZE);
    if (process.env.CALCULATION_COOLDOWN && process.env.CALCULATION_COOLDOWN.length >= 1) CONFIG.TIMING.CALCULATION_COOLDOWN = parseInt(process.env.CALCULATION_COOLDOWN);

}

checkConfig()
    .then(si.networkStats)
    .then(() => {
        console.log(`Checking latency ...`);
        return SpeedTest.multiPing(5);
    })
    .then((pings) => {
        const msg = `Experiencing ${Util.average(pings).toFixed(0)} ms of latency`;
        console.log(msg);
        logger.performance.info(msg);
    })
    .then(() => {
        console.log(`Fetching exchange info ...`);
        return BinanceApi.exchangeInfo();
    })
    .then(exchangeInfo => MarketCache.initialize(exchangeInfo, CONFIG.TRADING.WHITELIST, CONFIG.INVESTMENT.BASE))
    .then(checkBalances)
    .then(() => {
        // Listen for depth updates
        const tickers = MarketCache.tickers.watching;
        console.log(`Opening ${Math.ceil(tickers.length / CONFIG.WEBSOCKETS.BUNDLE_SIZE)} depth websockets ...`);
        if (CONFIG.WEBSOCKETS.BUNDLE_SIZE === 1) {
            return BinanceApi.depthCacheStaggered(tickers, CONFIG.DEPTH.SIZE, CONFIG.WEBSOCKETS.INITIALIZATION_INTERVAL);
        } else {
            return BinanceApi.depthCacheWebsockets(tickers, CONFIG.DEPTH.SIZE, CONFIG.WEBSOCKETS.BUNDLE_SIZE, CONFIG.WEBSOCKETS.INITIALIZATION_INTERVAL);
        }
    })
    .then(() => {
        console.log();
        console.log(`Investment Base:        ${CONFIG.INVESTMENT.BASE}`);
        console.log(`Investment Min:         ${CONFIG.INVESTMENT.MIN}`);
        console.log(`Investment Max:         ${CONFIG.INVESTMENT.MAX}`);
        console.log(`Investment Step:        ${CONFIG.INVESTMENT.STEP}`);
        console.log();
        console.log(`Execution Strategy:     ${CONFIG.TRADING.EXECUTION_STRATEGY}`);
        console.log(`Execution Limit:        ${CONFIG.TRADING.EXECUTION_CAP} execution(s)`);
        console.log(`Taker Fee:              ${CONFIG.TRADING.TAKER_FEE}`);
        console.log(`Profit Threshold:       ${CONFIG.TRADING.PROFIT_THRESHOLD.toFixed(2)}%`);
        console.log(`Age Threshold:          ${CONFIG.TRADING.AGE_THRESHOLD} ms`);
        console.log(`Log Level:              ${CONFIG.LOG.LEVEL}`);
        console.log();

        // Allow time for depth caches to populate
        setTimeout(calculateArbitrage, 6000);
        setInterval(displayStatusUpdate, CONFIG.TIMING.STATUS_UPDATE_INTERVAL);

        //Write opportunities to azure for further analysis
        setInterval(savePotentialOpportunities, 1000); 
        setInterval(saveExecutedOpportunities, 1000);
        setInterval(saveMissedOpportunities, 5000);
    })
    .catch(handleError);

function savePotentialOpportunities() {

    //Check if there were potential opportunities
    if (ArbitrageExecution.potentialOpportunities.length >= 1) {

        //Get the first pait in the array and remove it from the main array
        const firstElement = ArbitrageExecution.potentialOpportunities.shift();

        missedTable.insertEntity(process.env.AZURE_POTENTIAL_TABLE, firstElement, function (error, result, response) {
            if (error) {
                console.error("Could not log the potential opportunity in the table");
            }
        });
    }

}

function saveExecutedOpportunities() {

    //Check if there were executed opportunities
    if (ArbitrageExecution.executedOpportunities.length >= 1) {

        //Get the first pait in the array and remove it from the main array
        const firstElement = ArbitrageExecution.executedOpportunities.shift();

        executedTable.insertEntity(process.env.AZURE_EXECUTED_TABLE, firstElement, function (error, result, response) {
            if (error) {
                console.error("Could not log the potential opportunity in the table");
            }
        });
    }

}

function saveMissedOpportunities() {

    //Check if there were missed opportunities
    if (ArbitrageExecution.missedOpportunities.length >= 1) {

        //Get the first pait in the array and remove it from the main array
        const firstElement = ArbitrageExecution.missedOpportunities.shift();

        missedTable.insertEntity(process.env.AZURE_MISSED_TABLE, firstElement, function (error, result, response) {
            if (error) {
                console.error("Could not log the missed opportunity in the table");
            }
        });
    }

}

function calculateArbitrage() {
    if (isSafeToCalculateArbitrage()) {
        const depthSnapshots = BinanceApi.getDepthSnapshots(MarketCache.tickers.watching);
        MarketCache.pruneDepthCacheAboveThreshold(depthSnapshots, CONFIG.DEPTH.SIZE);

        const { calculationTime, successCount, errorCount, results } = CalculationNode.cycle(
            MarketCache.relationships,
            depthSnapshots,
            (e) => logger.performance.warn(e),
            ArbitrageExecution.isSafeToExecute,
            ArbitrageExecution.executeCalculatedPosition
        );

        recentCalculationTimes.push(calculationTime);
        if (CONFIG.HUD.ENABLED) refreshHUD(results);

        displayCalculationResults(successCount, errorCount, calculationTime);
    }

    setTimeout(calculateArbitrage, CONFIG.TIMING.CALCULATION_COOLDOWN);
}

function isSafeToCalculateArbitrage() {
    if (ArbitrageExecution.inProgressIds.size > 0) return false;
    return true;
}

function displayCalculationResults(successCount, errorCount, calculationTime) {
    if (errorCount === 0) return;
    const totalCalculations = successCount + errorCount;
    logger.performance.warn(`Completed ${successCount}/${totalCalculations} (${((successCount / totalCalculations) * 100).toFixed(1)}%) calculations in ${calculationTime} ms`);
}

function displayStatusUpdate() {
    const tickersWithoutDepthUpdate = MarketCache.getWatchedTickersWithoutDepthCacheUpdate();
    if (tickersWithoutDepthUpdate.length > 0) {
        logger.performance.debug(`Tickers without a depth cache update: [${tickersWithoutDepthUpdate}]`);
    }
    logger.performance.debug(`Calculation cycle average speed: ${Util.average(recentCalculationTimes).toFixed(2)} ms`);
    recentCalculationTimes = [];

    Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkStats(),
        SpeedTest.ping()
    ])
        .then(([load, memory, network, latency]) => {
            logger.performance.debug(`CPU Load: ${(load.avgload * 100).toFixed(0)}% [${load.cpus.map(cpu => cpu.load.toFixed(0) + '%')}]`);
            logger.performance.debug(`Memory Usage: ${Util.toGB(memory.used).toFixed(1)} GB`);
            logger.performance.debug(`Network Usage: ${Util.toKB(network[0].rx_sec).toFixed(1)} KBps (down) and ${Util.toKB(network[0].tx_sec).toFixed(1)} KBps (up)`);
            logger.performance.debug(`API Latency: ${latency} ms`);
        });
}

function handleError(err) {
    console.error(err);
    logger.binance.error(err);
    process.exit(1);
}

function checkConfig() {
    console.log(`Checking configuration ...`);

    const VALID_VALUES = {
        TRADING: {
            EXECUTION_STRATEGY: ['linear', 'parallel'],
            EXECUTION_TEMPLATE: ['BUY', 'SELL', null]
        },
        DEPTH: {
            SIZE: [5, 10, 20, 50, 100, 500]
        },
        LOG: {
            LEVEL: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
        }
    };

    if (CONFIG.INVESTMENT.MIN <= 0) {
        const msg = `INVESTMENT.MIN must be a positive value`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.INVESTMENT.STEP <= 0) {
        const msg = `INVESTMENT.STEP must be a positive value`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.INVESTMENT.MIN > CONFIG.INVESTMENT.MAX) {
        const msg = `INVESTMENT.MIN cannot be greater than INVESTMENT.MAX`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if ((CONFIG.INVESTMENT.MIN !== CONFIG.INVESTMENT.MAX) && (CONFIG.INVESTMENT.MAX - CONFIG.INVESTMENT.MIN) / CONFIG.INVESTMENT.STEP < 1) {
        const msg = `Not enough steps between INVESTMENT.MIN and INVESTMENT.MAX using step size of ${CONFIG.INVESTMENT.STEP}`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TRADING.WHITELIST.some(sym => sym !== sym.toUpperCase())) {
        const msg = `Whitelist symbols must all be uppercase`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TRADING.WHITELIST.length > 0 && !CONFIG.TRADING.WHITELIST.includes(CONFIG.INVESTMENT.BASE)) {
        const msg = `Whitelist must include the base symbol of ${CONFIG.INVESTMENT.BASE}`;
        logger.execution.debug(`Whitelist: [${CONFIG.TRADING.WHITELIST}]`);
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TRADING.EXECUTION_STRATEGY === 'parallel' && CONFIG.TRADING.WHITELIST.length === 0) {
        const msg = `Parallel execution requires defining a whitelist`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (!VALID_VALUES.TRADING.EXECUTION_STRATEGY.includes(CONFIG.TRADING.EXECUTION_STRATEGY)) {
        const msg = `${CONFIG.TRADING.EXECUTION_STRATEGY} is an invalid execution strategy`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (!CONFIG.TRADING.EXECUTION_TEMPLATE.every(template => VALID_VALUES.TRADING.EXECUTION_TEMPLATE.includes(template))) {
        const msg = `${CONFIG.TRADING.EXECUTION_TEMPLATE} is an invalid execution template`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TRADING.TAKER_FEE < 0) {
        const msg = `Taker fee (${CONFIG.TRADING.TAKER_FEE}) must be a positive value`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.DEPTH.SIZE > 100 && CONFIG.TRADING.WHITELIST.length === 0) {
        const msg = `Using a depth size higher than 100 requires defining a whitelist`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (!VALID_VALUES.DEPTH.SIZE.includes(CONFIG.DEPTH.SIZE)) {
        const msg = `Depth size can only contain one of the following values: ${VALID_VALUES.DEPTH.SIZE}`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (!VALID_VALUES.LOG.LEVEL.includes(CONFIG.LOG.LEVEL)) {
        const msg = `Log level can only contain one of the following values: ${VALID_VALUES.LOG.LEVEL}`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (isNaN(CONFIG.WEBSOCKETS.BUNDLE_SIZE) || CONFIG.WEBSOCKETS.BUNDLE_SIZE <= 0) {
        const msg = `Websocket bundle size (${CONFIG.WEBSOCKETS.BUNDLE_SIZE}) must be a positive integer`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (isNaN(CONFIG.WEBSOCKETS.INITIALIZATION_INTERVAL) || CONFIG.WEBSOCKETS.INITIALIZATION_INTERVAL < 0) {
        const msg = `Websocket initialization interval (${CONFIG.WEBSOCKETS.INITIALIZATION_INTERVAL}) must be a positive integer`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TIMING.RECEIVE_WINDOW > 60000) {
        const msg = `Receive window (${CONFIG.TIMING.RECEIVE_WINDOW}) must be less than 60000`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TIMING.RECEIVE_WINDOW <= 0) {
        const msg = `Receive window (${CONFIG.TIMING.RECEIVE_WINDOW}) must be a positive value`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TIMING.CALCULATION_COOLDOWN <= 0) {
        const msg = `Calculation cooldown (${CONFIG.TIMING.CALCULATION_COOLDOWN}) must be a positive value`;
        logger.execution.error(msg);
        throw new Error(msg);
    }
    if (CONFIG.TIMING.STATUS_UPDATE_INTERVAL <= 0) {
        const msg = `Status update interval (${CONFIG.TIMING.STATUS_UPDATE_INTERVAL}) must be a positive value`;
        logger.execution.error(msg);
        throw new Error(msg);
    }

    return Promise.resolve();
}

function checkBalances() {
    if (!CONFIG.TRADING.ENABLED) return;

    console.log(`Checking balances ...`);

    return BinanceApi.getBalances()
        .then(balances => {
            if (balances[CONFIG.INVESTMENT.BASE].available < CONFIG.INVESTMENT.MIN) {
                const msg = `Only detected ${balances[CONFIG.INVESTMENT.BASE].available} ${CONFIG.INVESTMENT.BASE}, but ${CONFIG.INVESTMENT.MIN} ${CONFIG.INVESTMENT.BASE} is required to satisfy your INVESTMENT.MIN configuration`;
                logger.execution.error(msg);
                throw new Error(msg);
            }
            if (balances[CONFIG.INVESTMENT.BASE].available < CONFIG.INVESTMENT.MAX) {
                const msg = `Only detected ${balances[CONFIG.INVESTMENT.BASE].available} ${CONFIG.INVESTMENT.BASE}, but ${CONFIG.INVESTMENT.MAX} ${CONFIG.INVESTMENT.BASE} is required to satisfy your INVESTMENT.MAX configuration`;
                logger.execution.error(msg);
                throw new Error(msg);
            }
            if (balances['BNB'].available <= 0.001) {
                const msg = `Only detected ${balances['BNB'].available} BNB which is not sufficient to pay for trading fees via BNB`;
                logger.execution.error(msg);
                throw new Error(msg);
            }
        });
}

function refreshHUD(arbs) {
    const arbsToDisplay = Object.values(arbs)
        .sort((a, b) => a.percent > b.percent ? -1 : 1)
        .slice(0, CONFIG.HUD.ARB_COUNT);
    HUD.displayArbs(arbsToDisplay);
}
