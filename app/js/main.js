"use strict";

const
    {app, dialog} = require('electron').remote,
	
	fs = require('fs'),

    {formatTime, setFileExtension} = require("./misc.js"),
	FlightLogVideoRenderer = require("./flightlog_video_renderer.js"),
    FlightLogFieldPresenter = require("./flightlog_fields_presenter.js"),
    VideoExportDialog = require("./video_export_dialog.js"),
    GraphConfig = require("./graph_config.js"),
	LayoutConfig = require("./layout_config.js"),
	LayoutConfigurationDialog = require("./layout_config_dialog.js"),
	GraphConfigurationDialog = require("./graph_config_dialog.js"),
    FlightLogGrapher = require("./grapher.js"),
    GraphLegend = require("./graph_legend.js"),
    
    {Presets, Preset} = require("./presets.js");

function pickOutputFile(suggestedName, filter) {
	return new Promise(function (resolve, reject) {
		dialog.showSaveDialog({
			title: "Write video to file...",
			defaultPath: suggestedName,
			filters: [
				filter
			]
		}, function (filename) {
			if (filename) {
				resolve(filename);
			} else {
				reject(null);
			}
		});
	});
}

function BlackboxLogViewer() {
    const
        GRAPH_STATE_PAUSED = 0,
        GRAPH_STATE_PLAY = 1,
        
        SMALL_JUMP_TIME = 100 * 1000,
        PLAYBACK_MIN_RATE = 5,
        PLAYBACK_MAX_RATE = 300,
        PLAYBACK_DEFAULT_RATE = 100,
        PLAYBACK_RATE_STEP = 5,
        GRAPH_MIN_ZOOM = 10,
        GRAPH_MAX_ZOOM = 1000,
        GRAPH_DEFAULT_ZOOM = 100,
        GRAPH_ZOOM_STEP = 10;
    
    var
        graphState = GRAPH_STATE_PAUSED,
        currentBlackboxTime = 0,
        lastRenderTime = false,
        flightLog, flightLogDataArray,
        graph = null, 
        
        prefs = new PrefStorage(),
        
        // User's video render config:
        videoConfig = {},
	
	    graphPresets = new Presets(),
	    layoutPresets = new Presets(),
	
	    /**
         * Graph configuration which is currently in use, customised based on the current flight log from graphConfig
         *
         * @type {GraphConfig}
	     */
	    activeGraphConfig = new GraphConfig(),
        
        graphLegend = null,
        fieldPresenter = FlightLogFieldPresenter,
        
        logFilename = null,
        
        hasVideo = false, hasLog = false,
        video = $(".log-graph video")[0],
        canvas = $("#graphCanvas")[0],
        craftCanvas = $("#craftCanvas")[0],
        videoURL = false,
        videoOffset = 0.0,
        
        videoExportInTime = false,
        videoExportOutTime = false,
        
        graphRendersCount = 0,
        
        seekBarCanvas = $(".log-seek-bar canvas")[0],
        seekBar = new SeekBar(seekBarCanvas),
        
        seekBarRepaintRateLimited = $.throttle(200, $.proxy(seekBar.repaint, seekBar)),
        
        updateValuesChartRateLimited,
        
        animationFrameIsQueued = false,
        
        playbackRate = PLAYBACK_DEFAULT_RATE,
        
        graphZoom = GRAPH_DEFAULT_ZOOM,
	
	    videoExportDialog;
    
    function blackboxTimeFromVideoTime() {
        return (video.currentTime - videoOffset) * 1000000 + flightLog.getMinTime();
    }
    
    function syncLogToVideo() {
        if (hasLog) {
            currentBlackboxTime = blackboxTimeFromVideoTime();
        }
    }
    
    function setVideoOffset(offset) {
        videoOffset = offset;
        
        /* 
         * Round to 2 dec places for display and put a plus at the start for positive values to emphasize the fact it's
         * an offset
         */
        $(".video-offset").val((videoOffset >= 0 ? "+" : "") + (videoOffset.toFixed(2) != videoOffset ? videoOffset.toFixed(2) : videoOffset));
        
        invalidateGraph();
    }
    
    function isInteger(value) {
        return (value | 0) == value || Math.trunc(value) == value;
    }
    
    function atMost2DecPlaces(value) {
        if (isInteger(value))
            return value; //it's an integer already
    
        if (value === null)
            return "(absent)";
        
        return value.toFixed(2);
    }
    
    function updateValuesChart() {
        var 
            table = $(".log-field-values table"),
            i,
            frame = flightLog.getSmoothedFrameAtTime(currentBlackboxTime),
            fieldNames = flightLog.getMainFieldNames();
        
        $("tr:not(:first)", table).remove();
        
        if (frame) {
            var 
                rows = [],
                rowCount = Math.ceil(fieldNames.length / 2);
            
            for (i = 0; i < rowCount; i++) {
                var 
                    row = 
                        "<tr>" +
                        '<td>' + fieldPresenter.fieldNameToFriendly(fieldNames[i]) + '</td>' +
                        '<td class="raw-value">' + atMost2DecPlaces(frame[i]) + '</td>' +
                        '<td>' + fieldPresenter.decodeFieldToFriendly(flightLog, fieldNames[i], frame[i]) + "</td>",
                        
                    secondColumn = i + rowCount;
                
                if (secondColumn < fieldNames.length) {
                    row += 
                        '<td>' + fieldPresenter.fieldNameToFriendly(fieldNames[secondColumn]) + '</td>' +
                        '<td>' + atMost2DecPlaces(frame[secondColumn]) + '</td>' +
                        '<td>' + fieldPresenter.decodeFieldToFriendly(flightLog, fieldNames[secondColumn], frame[secondColumn]) + '</td>';
                }
                
                row += "</tr>";
                
                rows.push(row);
            }
            
            table.append(rows.join(""));
        }
    }
    
    updateValuesChartRateLimited = $.throttle(250, updateValuesChart);
    
    function animationLoop() {
        var 
            now = Date.now();
        
        if (!graph) {
            animationFrameIsQueued = false;
            return;
        }
        
        if (hasVideo) {
            currentBlackboxTime = blackboxTimeFromVideoTime();
        } else if (graphState == GRAPH_STATE_PLAY) {
            var
                delta;
            
            if (lastRenderTime === false) {
                delta = 0;
            } else {
                delta = Math.floor((now - lastRenderTime) * 1000 * playbackRate / 100);
            }
    
            currentBlackboxTime += delta;
    
            if (currentBlackboxTime > flightLog.getMaxTime()) {
                currentBlackboxTime = flightLog.getMaxTime();
                setGraphState(GRAPH_STATE_PAUSED);
            }
        }
        
        graph.render(currentBlackboxTime);
        graphRendersCount++;
        
        seekBar.setCurrentTime(currentBlackboxTime);
    
        updateValuesChartRateLimited();
        
        if (graphState == GRAPH_STATE_PLAY) {
            lastRenderTime = now;
            
            seekBarRepaintRateLimited();
            
            animationFrameIsQueued = true;
            requestAnimationFrame(animationLoop);
        } else {
            seekBar.repaint();
            
            animationFrameIsQueued = false;
        }
    }
    
    function invalidateGraph() {
        if (!animationFrameIsQueued) {
            animationFrameIsQueued = true;
            requestAnimationFrame(animationLoop);
        }
    }
    
    function updateCanvasSize() {
        var
            width = $(canvas).width(),
            height = $(canvas).height();
        
        if (graph) {
            graph.resize(width, height);
            seekBar.resize(canvas.offsetWidth, 50);
            
            invalidateGraph();
        }
    }
    
    function renderLogFileInfo(file) {
        $(".log-filename").text(file.name);
        
        var 
            logIndexContainer = $(".log-index"),
            logIndexPicker,
            logCount = flightLog.getLogCount(),
            index;
        
        logIndexContainer.empty();
        
        if (logCount > 1) {
            logIndexPicker = $('<select class="log-index form-control">');
            
            logIndexPicker.change(function() {
                selectLog(parseInt($(this).val(), 10));
            });
        }
        
        for (index = 0; index < logCount; index++) {
            var
                logLabel,
                option, holder,
                error;
            
            error = flightLog.getLogError(index);
            
            if (error) {
                logLabel = "Error: " + error;
            } else {
                logLabel = formatTime(flightLog.getMinTime(index) / 1000, false) 
                    + " - " + formatTime(flightLog.getMaxTime(index) / 1000 , false)
                    + " [" + formatTime(Math.ceil((flightLog.getMaxTime(index) - flightLog.getMinTime(index)) / 1000), false) + "]";
            }
            
            if (logCount > 1) {
                option = $("<option></option>");
            
                option.text((index + 1) + "/" + (flightLog.getLogCount()) + ": " + logLabel);
                option.attr("value", index);
                
                if (error)
                    option.attr("disabled", "disabled");
                
                logIndexPicker.append(option);
            } else {
                holder = $('<div class="form-control-static"></div>');
                
                holder.text(logLabel);
                logIndexContainer.append(holder);
            }
        }
    
        if (logCount > 1) {
            logIndexPicker.val(0);
            logIndexContainer.append(logIndexPicker);
        }
    }
    
    /**
     * Update the metadata displays to show information about the currently selected log index.
     */
    function renderSelectedLogInfo() {
        $(".log-index").val(flightLog.getLogIndex());
        
        if (flightLog.getNumCellsEstimate()) {
            $(".log-cells").text(flightLog.getNumCellsEstimate() + "S (" + Number(flightLog.getReferenceVoltageMillivolts() / 1000).toFixed(2) + "V)");
            $(".log-cells-header,.log-cells").css('display', 'block');
        } else {
            $(".log-cells-header,.log-cells").css('display', 'none');
        }
        
        if (flightLog.getSysConfig().deviceUID != null) {
            $(".log-device-uid").text(flightLog.getSysConfig().deviceUID);
            $(".log-device-uid-header,.log-device-uid").css('display', 'block');
        } else {
           $(".log-device-uid-header,.log-device-uid").css('display', 'none');
        }
        
        seekBar.setTimeRange(flightLog.getMinTime(), flightLog.getMaxTime(), currentBlackboxTime);
        seekBar.setActivityRange(flightLog.getSysConfig().motorOutputLow, flightLog.getSysConfig().motorOutputHigh);
        
        var 
            activity = flightLog.getActivitySummary();
        
        seekBar.setActivity(activity.times, activity.avgThrottle, activity.hasEvent);
        
        seekBar.repaint();
    }
    
    function setGraphState(newState) {
        graphState = newState;
        
        lastRenderTime = false;
        
        switch (newState) {
            case GRAPH_STATE_PLAY:
                if (hasVideo) {
                    video.play();
                }
                $(".log-play-pause span").attr('class', 'glyphicon glyphicon-pause');
            break;
            case GRAPH_STATE_PAUSED:
                if (hasVideo) {
                    video.pause();
                }
                $(".log-play-pause span").attr('class', 'glyphicon glyphicon-play');
            break;
        }
        
        invalidateGraph();
    }
    
    function setCurrentBlackboxTime(newTime) {
        if (hasVideo) {
            video.currentTime = (newTime - flightLog.getMinTime()) / 1000000 + videoOffset;
        
            syncLogToVideo();
        } else {
            currentBlackboxTime = newTime;
        }
        
        invalidateGraph();
    }
    
    function setVideoTime(newTime) {
        video.currentTime = newTime;
    
        syncLogToVideo();
    }
    
    function setVideoInTime(inTime) {
        videoExportInTime = inTime;
        
        if (seekBar) {
            seekBar.setInTime(videoExportInTime);
        }
        
        if (graph) {
            graph.setInTime(videoExportInTime);
            invalidateGraph();
        }
    }
    
    function setVideoOutTime(outTime) {
        videoExportOutTime = outTime;
        
        if (seekBar) {
            seekBar.setOutTime(videoExportOutTime);
        }
        
        if (graph) {
            graph.setOutTime(videoExportOutTime);
            invalidateGraph();
        }
    }
    
    function setPlaybackRate(rate) {
        if (rate >= PLAYBACK_MIN_RATE && rate <= PLAYBACK_MAX_RATE) {
              playbackRate = rate;
              
              if (video) {
                  video.playbackRate = rate / 100;
              }
        }
    }
    
    function setGraphZoom(zoom) {
        if (zoom >= GRAPH_MIN_ZOOM && zoom <= GRAPH_MAX_ZOOM) {
            graphZoom = zoom;
            
            if (graph) {
                graph.setGraphZoom(zoom / 100);
                invalidateGraph();
            }
        }
    }
    
    /**
     * Set the index of the log from the log file that should be viewed. Pass "null" as the index to open the first
     * available log.
     */
    function selectLog(logIndex) {
        var
            success = false;
        
        try {
            if (logIndex === null) {
                for (var i = 0; i < flightLog.getLogCount(); i++) {
                    if (flightLog.openLog(i)) {
                        success = true;
                        break;
                    }
                }
                
                if (!success) {
                    throw "No logs in this file could be parsed successfully";
                }
            } else {
                flightLog.openLog(logIndex);
            }
        } catch (e) {
            alert("Error opening log: " + e);
            return;
        }
        
        if (graph) {
            graph.destroy();
        }
        
        graph = new FlightLogGrapher(flightLog, activeGraphConfig, layoutPresets.getActivePreset(), canvas, craftCanvas);
        
        setVideoInTime(false);
        setVideoOutTime(false);
    
        activeGraphConfig.adaptGraphs(flightLog, graphPresets.getActivePreset().graphs);
        
        graph.onSeek = function(offset) {
            //Seek faster
            offset *= 2;
            
            if (hasVideo) {
                setVideoTime(video.currentTime + offset / 1000000);
            } else {
                setCurrentBlackboxTime(currentBlackboxTime + offset);
            }
            invalidateGraph();
        };
        
        if (hasVideo) {
            syncLogToVideo();
        } else {
            // Start at beginning:
            currentBlackboxTime = flightLog.getMinTime();
        }
        
        renderSelectedLogInfo();
        
        updateCanvasSize();
        
        setGraphState(GRAPH_STATE_PAUSED);
        setGraphZoom(graphZoom);
    }
    
    function loadLogFile(file) {
        var reader = new FileReader();
    
        reader.onload = function(e) {
            var bytes = e.target.result;
            
            flightLogDataArray = new Uint8Array(bytes);
            
            try {
                flightLog = new FlightLog(flightLogDataArray);
            } catch (err) {
                alert("Sorry, an error occured while trying to open this log:\n\n" + err);
                return;
            }
            
            logFilename = file.path;
            renderLogFileInfo(file);
            
            hasLog = true;
            $("html").addClass("has-log");
            
            selectLog(null);
        };
    
        reader.readAsArrayBuffer(file);
    }
    
    function loadVideo(file) {
        if (videoURL) {
            URL.revokeObjectURL(videoURL);
            videoURL = false;
        }
        
        if (!URL.createObjectURL) {
            alert("Sorry, your web browser doesn't support showing videos from your local computer. Try Google Chrome instead.");
            return;
        }
            
        videoURL = URL.createObjectURL(file);
        video.volume = 0.05;
        video.src = videoURL;
        
        // Reapply the last playbackRate to the new video
        setPlaybackRate(playbackRate);
    }
    
    function videoLoaded(e) {
        hasVideo = true;
        
        $("html").addClass("has-video");
        
        setGraphState(GRAPH_STATE_PAUSED);
    }
    
    function reportVideoError(e) {
        alert("Your video could not be loaded, your browser might not support this kind of video. Try Google Chrome instead.");
    }
    
    function onLegendVisbilityChange(hidden) {
        prefs.set('log-legend-hidden', hidden);
        updateCanvasSize();
    }
    
    function showVideoExportDialog() {
        setGraphState(GRAPH_STATE_PAUSED);
    
        var
            logParameters = {
                graphConfig: activeGraphConfig,
                inTime: videoExportInTime,
                outTime: videoExportOutTime,
                flightVideo: hasVideo ? video.cloneNode() : false,
                flightVideoOffset: videoOffset
            };
    
        if (!("inTime" in logParameters) || logParameters.inTime === false) {
            logParameters.inTime = flightLog.getMinTime();
        }
    
        if (!("outTime" in logParameters) || logParameters.outTime === false) {
            logParameters.outTime = flightLog.getMaxTime();
        }
    
        videoExportDialog.show(logParameters, videoConfig);
    }
    
    function onVideoExportOptionsChosen(logParameters, _videoConfig) {
        var
            pickFilename;
	
        // Remember these settings for next dialog open...
	    videoConfig = _videoConfig;
	
	    // And next application launch...
	    prefs.set('videoConfig', videoConfig);
        
        if (videoConfig.format == "webm") {
	        pickFilename = pickOutputFile(setFileExtension(logFilename, ".webm"), {
		        name: "WebM video",
		        extensions: ["webm"]
	        });
        } else {
	        pickFilename = pickOutputFile(setFileExtension(logFilename, ".png"), {
		        name: "PNG frames",
		        extensions: ["png"]
	        });
        }
	
	    pickFilename
            .catch(function() {
                videoExportDialog.close();
                
                return Promise.reject();
            })
            .then(function(filename) {
                videoConfig.filename = filename;
            })
            .then(function() {
                var
                    videoRenderer = new FlightLogVideoRenderer(flightLog, logParameters, videoConfig);
	
	            videoRenderer.start();
	
	            videoExportDialog.onRenderingBegin(videoRenderer);
                
	            videoExportDialog.once("cancel", function() {
                    videoRenderer.cancel();
                });
            });
    }
    
    function createDialogs() {
	    var
		    graphConfigDialog = new GraphConfigurationDialog($("#dlgGraphConfiguration"), graphPresets);
	
	    $(".open-graph-configuration-dialog").click(function(e) {
		    e.preventDefault();
		
		    graphConfigDialog.show(flightLog);
	    });
	
	    var
		    layoutConfigDialog = new LayoutConfigurationDialog($("#dlgLayoutConfiguration"), layoutPresets);
	
	    $(".open-layout-configuration-dialog").click(function(e) {
		    e.preventDefault();
		
		    layoutConfigDialog.show(flightLog);
	    });
	
	    videoExportDialog = new VideoExportDialog($("#dlgVideoExport"), layoutPresets);
	
	    videoExportDialog.on("optionsChosen", onVideoExportOptionsChosen);
	
	    $(".btn-video-export").click(function(e) {
		    showVideoExportDialog();
		    e.preventDefault();
	    });
    }
    
    function loadPreferences() {
	    prefs.get('videoConfig', function (item) {
		    if (item) {
			    videoConfig = item;
		    } else {
			    videoConfig = {
				    width: 1280,
				    height: 720,
				    frameRate: 30,
				    videoDim: 0.4
			    };
		    }
	    });
	    
	    graphPresets = new Presets([
	        new Preset(
	            "Default",
                {
                    graphs: GraphConfig.getExampleGraphConfigs(flightLog,
                        ["Motors", "Gyros", "Gyro + PID roll", "Gyro + PID pitch", "Gyro + PID yaw"])
                },
                true
            )
        ]);
	
	    // Do we have an old graphConfig to upgrade to the new preset format?
	    // prefs.get('graphConfig', function (item) {
		 //    var
         //        graphConfig = GraphConfig.load(item);
        //
		 //    if (graphConfig) {
			//     prefs.remove('graphConfig');
        //
			//     graphPresets.add(new Preset("Custom preset", {graphs: graphConfig}, false));
		 //    } else {
		 //        // Okay, then do we have any of the new format "graphPresets"?
		 //        prefs.get('graphPresets', function(item) {
         //            graphPresets.load(item, false);
         //        });
		 //    }
	    // });
	    
	    let
            defaultLayout = LayoutConfig.getDefaultConfig();
	    
	    layoutPresets = new Presets();
	
	    layoutPresets.on("validate", function(preset) {
	        LayoutConfig.fixUp(preset, defaultLayout);
	    });
	
	    layoutPresets.add(new Preset(
		    "Default",
		    defaultLayout,
		    true
	    ));
        
	    prefs.get('layoutPresets', function (item) {
		    layoutPresets.load(item, false);
	    });
    }

    function attachPreferenceChangeHandlers() {
	    graphPresets.on("activePresetChange", function(newPreset) {
		    activeGraphConfig.adaptGraphs(flightLog, newPreset.content.graphs);
		    invalidateGraph();
	    });
	
	    layoutPresets.on("activePresetChange", function() {
	        graph.setDisplayConfig(layoutPresets.getActivePreset());
	        invalidateGraph();
	    });
	
	    // Persist preferences to storage every time they are changed (not just at program exit)
	    layoutPresets.on("change", function() {
		    prefs.set('layoutPresets', layoutPresets.save(false));
	    });
	
	    graphPresets.on("change", function() {
		    prefs.set('graphPresets', graphPresets.save(false));
	    });
    }
    
    loadPreferences();
	
    attachPreferenceChangeHandlers();

	$(document).ready(function() {
        graphLegend = new GraphLegend($(".log-graph-legend"), activeGraphConfig, onLegendVisbilityChange);
        
        prefs.get('log-legend-hidden', function(item) {
            if (item) {
                graphLegend.hide();
            }
        });
	
	    $(".file-open").change(function(e) {
            var 
                files = e.target.files,
                i;
            
            for (i = 0; i < files.length; i++) {
                var
                    isLog = files[i].name.match(/\.(TXT|CFL|LOG)$/i),
                    isVideo = files[i].name.match(/\.(AVI|MOV|MP4|MPEG|WEBM)$/i);
                
                if (!isLog && !isVideo) {
                    if (files[i].size < 10 * 1024 * 1024)
                        isLog = true; //Assume small files are logs rather than videos
                    else
                        isVideo = true;
                }
                
                if (isLog) {
                    loadLogFile(files[i]);
                } else if (isVideo) {
                    loadVideo(files[i]);
                }
            }
        });
        
        $(".log-jump-back").click(function() {
            if (hasVideo) {
                setVideoTime(video.currentTime - SMALL_JUMP_TIME / 1000000);
            } else {
                setCurrentBlackboxTime(currentBlackboxTime - SMALL_JUMP_TIME);
            }
            
            setGraphState(GRAPH_STATE_PAUSED);
        });
    
        $(".log-jump-forward").click(function() {
            if (hasVideo) {
                setVideoTime(video.currentTime + SMALL_JUMP_TIME / 1000000);
            } else {
                setCurrentBlackboxTime(currentBlackboxTime + SMALL_JUMP_TIME);
            }
            
            setGraphState(GRAPH_STATE_PAUSED);
        });
        
        $(".log-jump-start").click(function() {
            setCurrentBlackboxTime(flightLog.getMinTime());
            setGraphState(GRAPH_STATE_PAUSED);
        });
    
        $(".log-jump-end").click(function() {
            setCurrentBlackboxTime(flightLog.getMaxTime());
            setGraphState(GRAPH_STATE_PAUSED);
        });
        
        $(".video-jump-start").click(function() {
            setVideoTime(0);
            setGraphState(GRAPH_STATE_PAUSED);
        });
    
        $(".video-jump-end").click(function() {
            if (video.duration) {
                setVideoTime(video.duration);
                setGraphState(GRAPH_STATE_PAUSED);
            }
        });
        
        $(".log-play-pause").click(function() {
            if (graphState == GRAPH_STATE_PAUSED) {
                setGraphState(GRAPH_STATE_PLAY);
            } else {
                setGraphState(GRAPH_STATE_PAUSED);
            }
        });
        
        $(".log-sync-here").click(function() {
            setVideoOffset(video.currentTime);
        });
        
        $(".log-sync-back").click(function() {
            setVideoOffset(videoOffset - 1 / 15);
        });
    
        $(".log-sync-forward").click(function() {
            setVideoOffset(videoOffset + 1 / 15);
        });
    
        $(".video-offset").change(function() {
            var offset = parseFloat($(".video-offset").val());
            
            if (!isNaN(offset)) {
                videoOffset = offset;
                invalidateGraph();
            }
        });
        
        createDialogs();
        
        $(window).resize(updateCanvasSize);
        
        $(document).keydown(function(e) {
            if (graph && !(e.altkey || e.shiftKey || e.ctrlKey || e.metaKey) && $(e.target).parents('.modal').length == 0) {
                switch (e.which) {
                    case "I".charCodeAt(0):
                        if (videoExportInTime === currentBlackboxTime) {
                            setVideoInTime(false)
                        } else {
                            setVideoInTime(currentBlackboxTime);
                        }
                        
                        e.preventDefault();
                    break;
                    case "O".charCodeAt(0):
                        if (videoExportOutTime === currentBlackboxTime) {
                            setVideoOutTime(false);
                        } else {
                            setVideoOutTime(currentBlackboxTime);
                        }
                        
                        e.preventDefault();
                    break;
                }
            }
        });
        
        $(video).on({
            loadedmetadata: updateCanvasSize,
            error: reportVideoError,
            loadeddata: videoLoaded
        });
        
        var percentageFormat = {
            to: function(value) {
                return value.toFixed(0) + "%";
            },
            from: function(value) {
                return parseFloat(value);
            }
        };
        
        $(".playback-rate-control")
            .noUiSlider({
                start: playbackRate,
                connect: false,
                step: PLAYBACK_RATE_STEP,
                range: {
                    'min': [ PLAYBACK_MIN_RATE ],
                    '50%': [ PLAYBACK_DEFAULT_RATE, PLAYBACK_RATE_STEP ],
                    'max': [ PLAYBACK_MAX_RATE, PLAYBACK_RATE_STEP ]
                },
                format: percentageFormat
            })
            .on("slide change set", function() {
                setPlaybackRate(parseFloat($(this).val()));
            })
            .Link("lower").to($(".playback-rate"));
    
        $(".graph-zoom-control")
            .noUiSlider({
                start: graphZoom,
                connect: false,
                step: GRAPH_ZOOM_STEP,
                range: {
                    'min': [ GRAPH_MIN_ZOOM ],
                    '50%': [ GRAPH_DEFAULT_ZOOM, GRAPH_ZOOM_STEP ],
                    'max': [ GRAPH_MAX_ZOOM, GRAPH_ZOOM_STEP ]
                },
                format: percentageFormat
            })
            .on("slide change set", function() {
                setGraphZoom(parseFloat($(this).val()));
            })
            .Link("lower").to($(".graph-zoom"));
        
        $('.navbar-toggle').click(function(e) {
            $('.navbar-collapse').collapse('toggle');
            
            e.preventDefault();
        });
        
        seekBar.onSeek = setCurrentBlackboxTime;
        
        $(".app-version").text("v" + app.getVersion());
    });

    // Boostrap's data API is extremely slow when there are a lot of DOM elements churning, don't use it
	$(document).off('.data-api');
}

module.exports = BlackboxLogViewer;