/// <reference types="node" />

// The MIT License (MIT)
// 
// vs-rest-api (https://github.com/mkloubert/vs-rest-api)
// Copyright (c) Marcel Joachim Kloubert <marcel.kloubert@gmx.net>
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.


const Entities = require('html-entities').AllHtmlEntities;
import * as FS from 'fs';
import * as HTTP from 'http';
import * as HTTPs from 'https';
import * as Moment from 'moment';
import * as Path from 'path';
import * as rapi_contracts from './contracts';
import * as rapi_controller from './controller';
import * as rapi_helpers from './helpers';
import * as rapi_host_dirs from './host/dirs';
import * as rapi_host_files from './host/files';
import * as rapi_host_helpers from './host/helpers';
import * as rapi_users from './host/users';
import * as URL from 'url';
import * as vscode from 'vscode';


/**
 * The default text encoding.
 */
export const DEFAULT_ENCODING = 'utf8';
/**
 * The default port for the workspace host.
 */
export const DEFAULT_PORT = 1781;
/**
 * Checks if URL path represents an API request.
 */
export const REGEX_API = /^(\/)(api)(\/)?/i;

/**
 * The APU context.
 */
export interface ApiContext {
    /**
     * The content to use instead of 'ApiContext.response'.
     */
    content?: any;
    /**
     * The text encoding to use.
     */
    encoding: string;
    /**
     * The response headers to send.
     */
    headers: { [key: string]: any };
    /**
     * The request context.
     */
    request: RequestContext;
    /**
     * The response data.
     */
    response: ApiResponse;
    /**
     * Sets up the response for a 405 HTTP response.
     * 
     * @chainable
     */
    sendMethodNotAllowed: () => ApiContext;
    /**
     * Sets up the response for a 404 HTTP response.
     * 
     * @chainable
     */
    sendNotFound: () => ApiContext;
    /**
     * Sets the content of 'ApiContext.content'.
     * 
     * @param {any} newContent The new content to set.
     * @param {string} mime The content / mime type.
     * 
     * @chainable
     */
    setContent: (newContent: any, mime?: string) => ApiContext;
    /**
     * The status code.
     */
    statusCode?: number;
    /**
     * Writes data to the response.
     * 
     * @chainable
     */
    write: (data: any) => ApiContext;
}

/**
 * An API method.
 * 
 * @param {ApiContext} ctx The context.
 * 
 * @return {Promise<any>|void} The result.
 */
export type ApiMethod = (ctx: ApiContext) => Promise<any> | void;

/**
 * An API response.
 */
export interface ApiResponse {
    /**
     * The code.
     */
    code: number;
    /**
     * The data.
     */
    data?: any;
    /**
     * The message.
     */
    msg?: string;
}

/**
 * A request context.
 */
export interface RequestContext {
    /**
     * The current configuration.
     */
    config: rapi_contracts.Configuration;
    /**
     * The GET parameters.
     */
    GET: { [key: string]: string };
    /**
     * The name of the request method.
     */
    method: string;
    /**
     * Gets the HTTP request context.
     */
    request: HTTP.IncomingMessage;
    /**
     * Gets the HTTP response context.
     */
    response: HTTP.ServerResponse;
    /**
     * The request time.
     */
    time: Moment.Moment;
    /**
     * The URL as object.
     */
    url: URL.Url;
    /**
     * The current user.
     */
    user?: rapi_users.User;
}


/**
 * A HTTP for browsing the workspace.
 */
export class ApiHost implements vscode.Disposable {
    /**
     * Stores the underlying controller.
     */
    protected readonly _CONTROLLER: rapi_controller.Controller;
    /**
     * The current server instance.
     */
    protected _server: HTTP.Server | HTTPs.Server;

    /**
     * Initializes a new instance of that class.
     * 
     * @param {rapi_controller.Controller} controller The underlying controller.
     */
    constructor(controller: rapi_controller.Controller) {
        this._CONTROLLER = controller;
    }

    /**
     * Gets the underlying controller.
     */
    public get controller(): rapi_controller.Controller {
        return this._CONTROLLER;
    }
    
    /** @inheritdoc */
    public dispose() {
        let me = this;
        
        me.stop().then(() => {
            //TODO
        }).catch((err) => {
            me.controller.log(`[ERROR] host.dispose(): ${rapi_helpers.toStringSafe(err)}`);
        });
    }

    /**
     * Handles an API call.
     * 
     * @param {RequestContext} ctx The request context.
     * @param {ApiResponse} response The predefined response data.
     */
    protected handleApi(ctx: RequestContext, response: ApiResponse) {
        try {
            let method: ApiMethod;

            let normalizedPath = rapi_helpers.toStringSafe(ctx.url.pathname);
            normalizedPath = rapi_helpers.replaceAllStrings(normalizedPath, "\\", '/');
            normalizedPath = rapi_helpers.replaceAllStrings(normalizedPath, Path.sep, '/');
            normalizedPath = rapi_helpers.normalizeString(normalizedPath);

            let parts = normalizedPath.substr(4)
                                      .split('/')
                                      .map(x => rapi_helpers.normalizeString(x))
                                      .filter(x => !rapi_helpers.isEmptyString(x));

            let isRoot = true;

            if (parts.length > 0) {
                let modName = rapi_helpers.cleanupString(parts[0]);
                if (!rapi_helpers.isEmptyString(modName)) {
                    isRoot = false;

                    // try load module
                    let mod: any;
                    try {
                        mod = require(`./api/${modName}`);
                    }
                    catch (e) { /* not found */ }

                    if (mod) {
                        // search for function that
                        // has the same name as the HTTP request
                        // method
                        for (let p in mod) {
                            if (p == ctx.method) {
                                if ('function' === typeof mod[p]) {
                                    method = mod[p];
                                }

                                break;
                            }
                        }

                        if (!method) {
                            // no matching method found

                            method = (ac) => {
                                ac.sendMethodNotAllowed();
                            };
                        }
                    }
                }
            }

            if (isRoot) {
                // root
                method = (ac) => {
                    ac.response.data = {
                        addr: ctx.request.connection.remoteAddress,
                        time: ctx.time.format('YYYY-MM-DD HH:mm:ss'),
                    };

                    if (!ctx.user.isGuest) {
                        ac.response.data.me = {
                            name: rapi_helpers.normalizeString(ctx.user.account['name']),
                        };
                    }
                };
            }

            if (method) {
                let apiCtx: ApiContext = {
                    encoding: DEFAULT_ENCODING,
                    headers: {
                        'Content-type': 'application/json; charset=utf-8',
                    },
                    request: ctx,
                    response: response,
                    setContent: function(newContent, mime) {
                        delete this.response;

                        this.content = newContent;

                        mime = rapi_helpers.normalizeString(mime);
                        if (mime) {
                            if (!this.headers) {
                                this.headers = {};
                            }

                            this.headers['Content-type'] = mime;
                        }

                        return this;
                    },
                    sendMethodNotAllowed: function() {
                        this.statusCode = 405;
                        
                        delete this.response;
                        delete this.headers;

                        return this;
                    },
                    sendNotFound: function() {
                        this.statusCode = 404;
                        
                        delete this.response;
                        delete this.headers;

                        return this;
                    },
                    statusCode: 200,
                    write: function(data) {
                        if (!data) {
                            return;
                        }

                        let enc = rapi_helpers.normalizeString(this.encoding);
                        if (!enc) {
                            enc = DEFAULT_ENCODING;
                        }

                        this.request
                            .response.write(rapi_helpers.asBuffer(data), enc);

                        return this;
                    }
                };

                let sendResponse = (err?: any) => {
                    if (err) {
                        rapi_host_helpers.sendError(err, ctx);
                    }
                    else {
                        try {
                            let enc = rapi_helpers.normalizeString(apiCtx.encoding);
                            if (!enc) {
                                enc = DEFAULT_ENCODING;
                            }

                            let responseData: any;
                            if (apiCtx.response) {
                                responseData = JSON.stringify(response);
                            }
                            else {
                                responseData = apiCtx.content;
                            }

                            let sendResponseData = (finalDataToSend: any) => {
                                let statusCode = apiCtx.statusCode;
                                if (rapi_helpers.isEmptyString(statusCode)) {
                                    statusCode = 200;
                                }
                                else {
                                    statusCode = parseInt(rapi_helpers.normalizeString(apiCtx.statusCode));
                                }

                                ctx.response.writeHead(statusCode, apiCtx.headers);

                                ctx.response.write(rapi_helpers.asBuffer(finalDataToSend));

                                ctx.response.end();
                            };

                            rapi_host_helpers.compressForResponse(responseData, ctx, enc).then((compressResult) => {
                                if (compressResult.contentEncoding) {
                                    if (!apiCtx.headers) {
                                        apiCtx.headers = {};
                                    }

                                    apiCtx.headers['Content-encoding'] = compressResult.contentEncoding;
                                }

                                sendResponseData(compressResult.dataToSend);
                            }).catch((err) => {
                                sendResponseData(responseData);
                            });
                        }
                        catch (e) {
                            rapi_host_helpers.sendError(e, ctx);
                        }
                    }
                }
                
                let methodResult = method(apiCtx);
                if (methodResult) {
                    // async / promise call

                    methodResult.then(() => {
                        sendResponse();
                    }).catch((err) => {
                        rapi_host_helpers.sendError(err, ctx);
                    });
                }
                else {
                    sendResponse();
                }
            }
            else {
                rapi_host_helpers.sendNotFound(ctx);
            }
        }
        catch (e) {
            rapi_host_helpers.sendError(e, ctx);
        }
    }

    /**
     * Handles a request.
     * 
     * @param {RequestContext} ctx The request context.
     */
    protected handleRequest(ctx: RequestContext) {
        let me = this;

        let normalizedPath = rapi_helpers.normalizeString(ctx.url.pathname);

        if (REGEX_API.test(normalizedPath)) {
            // API
            let apiResponse: ApiResponse = {
                code: 0,
            };
            
            me.handleApi(ctx, apiResponse);
            return;
        }

        rapi_host_helpers.sendNotFound(ctx);
    }

    /**
     * Starts the server.
     * 
     * @param {number} [port] The custom TCP port to use.
     * 
     * @return Promise<boolean> The promise.
     */
    public start(port?: number): Promise<boolean> {
        if (rapi_helpers.isNullOrUndefined(port)) {
            port = DEFAULT_PORT;
        }
        port = parseInt(rapi_helpers.toStringSafe(port).trim());
        
        let me = this;

        let cfg = rapi_helpers.cloneObject(me.controller.config);

        let accounts: rapi_contracts.Account[] = rapi_helpers.asArray(cfg.users);
        if ('object' === typeof cfg.guest) {
            accounts.push(cfg.guest);
        }

        // init global storages
        accounts.filter(x => x).forEach(x => {
            x.__globals = {};
            x.__globals[rapi_users.VAR_VISIBLE_FILES] = {};
        });
        
        return new Promise<boolean>((resolve, reject) => {
            let completed = rapi_helpers.createSimplePromiseCompletedAction(resolve, reject);

            try {
                if (me._server) {
                    completed(null, false);
                    return;
                }

                let requestListener = (req: HTTP.IncomingMessage, resp: HTTP.ServerResponse) => {
                    try {
                        let url = URL.parse(req.url);

                        let ctx: RequestContext = {
                            config: cfg,
                            GET: <any>rapi_host_helpers.urlParamsToObject(url),
                            method: rapi_helpers.normalizeString(req.method),
                            request: req,
                            response: resp,
                            time: Moment().utc(),
                            url: url,
                        };

                        if (!ctx.method) {
                            ctx.method = 'get';
                        }

                        ctx.user = rapi_users.getUser(ctx);
                        if (!ctx.user) {
                            rapi_host_helpers.sendUnauthorized(ctx);
                            return;
                        }

                        try {
                            me.handleRequest(ctx);
                        }
                        catch (e) {
                            rapi_host_helpers.sendError(e, ctx);
                        }
                    }
                    catch (e) {
                        try {
                            resp.statusCode = 500;
                            resp.end();
                        }
                        catch (e) {
                            //TODO: log
                        }
                    }
                };

                let newServer: HTTP.Server | HTTPs.Server;

                if (cfg.ssl) {
                    let ca: Buffer;
                    let cert: Buffer;
                    let key: Buffer;
                    let passphrase: string;

                    if (cfg.ssl.passphrase) {
                        passphrase = rapi_helpers.toStringSafe(cfg.ssl.passphrase);
                    }

                    if (!rapi_helpers.isEmptyString(cfg.ssl.ca)) {
                        let caFile = rapi_helpers.toStringSafe(cfg.ssl.ca);
                        if (!Path.isAbsolute(caFile)) {
                            caFile = Path.join(vscode.workspace.rootPath, caFile);
                        }
                        caFile = Path.resolve(caFile);

                        ca = FS.readFileSync(caFile);
                    }

                    if (!rapi_helpers.isEmptyString(cfg.ssl.cert)) {
                        let certFile = rapi_helpers.toStringSafe(cfg.ssl.cert);
                        if (!Path.isAbsolute(certFile)) {
                            certFile = Path.join(vscode.workspace.rootPath, certFile);
                        }
                        certFile = Path.resolve(certFile);

                        cert = FS.readFileSync(certFile);
                    }

                    if (!rapi_helpers.isEmptyString(cfg.ssl.key)) {
                        let keyFile = rapi_helpers.toStringSafe(cfg.ssl.key);
                        if (!Path.isAbsolute(keyFile)) {
                            keyFile = Path.join(vscode.workspace.rootPath, keyFile);
                        }
                        keyFile = Path.resolve(keyFile);

                        key = FS.readFileSync(keyFile);
                    }

                    newServer = HTTPs.createServer({
                        ca: ca,
                        cert: cert,
                        key: key,
                        passphrase: passphrase,
                        rejectUnauthorized: rapi_helpers.toBooleanSafe(cfg.ssl.rejectUnauthorized, true),
                    }, requestListener);
                }
                else {
                    newServer = HTTP.createServer(requestListener);
                }

                newServer.on('error', (err) => {
                    completed(err || new Error(`Unknown error! Maybe port '${port}' is in use.`));
                });

                newServer.listen(port, function() {
                    me._server = newServer;
                    completed(null, true);
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    /**
     * Starts the server.
     * 
     * @param {number} [port] The custom TCP port to use.
     * 
     * @return Promise<boolean> The promise.
     */
    public stop(): Promise<boolean> {
        let me = this;
        
        return new Promise<boolean>((resolve, reject) => {
            let completed = rapi_helpers.createSimplePromiseCompletedAction(resolve, reject);

            try {
                let oldServer = me._server;
                if (!oldServer) {
                    completed(null, false);
                    return;
                }

                oldServer.close(function(err) {
                    if (err) {
                        completed(err);
                    }
                    else {
                        me._server = null;
                        completed(null, true);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }
}