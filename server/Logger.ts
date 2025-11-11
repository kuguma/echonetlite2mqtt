import { TransformableInfo } from "logform";
import winston from "winston";
import path from "path";

const myConsoleFormat = winston.format.printf((info: TransformableInfo) =>{
  const timestamp = info.timestamp || new Date().toISOString();
  const timeStr = new Date(timestamp as string).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');

  if(info.category!==undefined)
  {
    return `${timeStr} ${info.level.padEnd(5," ")} ${info.category} ${info.message}`;
  }
  else
  {
    return `${timeStr} ${info.level.padEnd(5," ")} ${info.message}`;
  }
})

// 環境変数からログレベルを取得（デフォルト: info）
const logLevel = process.env.ECHONET_LOG_LEVEL?.toLowerCase() || 'info';

const logger = winston.createLogger({
  level: logLevel,
  transports: [
    new winston.transports.Console({format: winston.format.combine(
        winston.format.timestamp(),
        myConsoleFormat
      )}),
    new winston.transports.File({
      filename: "detail.log",
      dirname: path.resolve(__dirname, "..", "logs"),
      maxFiles: 5,
      maxsize: 1 * 1024*1024, //bytes
      tailable: true,
      format:winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )}),
  ],
});

const unhandledErrorLoggerForLogFile = winston.createLogger({
  format: winston.format.json(),
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  ]    
});
const unhandledErrorLoggerForConsole = winston.createLogger({
  format: winston.format.cli(),
  exceptionHandlers: [
    new winston.transports.Console()
  ]    
});
  

export class Logger
{
  public static error = (category:string,text:string, meta:{[key:string]:unknown} = {})=>
  {
    if(category !== "")
    {
      meta["category"] = category;
    }
    logger.error(text, meta);
  }
  public static warn = (category:string,text:string, meta:{[key:string]:unknown} = {})=>
  {
    if(category !== "")
    {
      meta["category"] = category;
    }
    logger.warn(text, meta);
  }
  public static info = (category:string,text:string, meta:{[key:string]:unknown} = {})=>
  {
    if(category !== "")
    {
      meta["category"] = category;
    }
    logger.info(text, meta);
  }
  public static debug = (category:string,text:string, meta:{[key:string]:unknown} = {})=>
  {
    if(category !== "")
    {
      meta["category"] = category;
    }
    logger.debug(text, meta);
  }
}