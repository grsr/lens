# Lens firmware build.
# Requires PICO_SDK_PATH or the pico-vscode extension cmake file.

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.1.1)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.1.1)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================

cmake_minimum_required(VERSION 3.13)

# pico_sdk_import.cmake is at the repo root.
include(${CMAKE_CURRENT_LIST_DIR}/pico_sdk_import.cmake)

project(lens C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

# ---- Bake factory snapshot before the build begins ----
find_program(NODE_EXECUTABLE node REQUIRED)

set(FACTORY_H ${CMAKE_CURRENT_LIST_DIR}/runtime/factory_snapshot.h)
set(FACTORY_INPUTS
    ${CMAKE_CURRENT_LIST_DIR}/runtime/bake_factory.js
    ${CMAKE_CURRENT_LIST_DIR}/patches/meta-turing-machine.loupe
    ${CMAKE_CURRENT_LIST_DIR}/prelude.loupe
    ${CMAKE_CURRENT_LIST_DIR}/compiler/reader.js
    ${CMAKE_CURRENT_LIST_DIR}/compiler/expander.js
    ${CMAKE_CURRENT_LIST_DIR}/compiler/lowerer.js
    ${CMAKE_CURRENT_LIST_DIR}/compiler/scheduler.js
    ${CMAKE_CURRENT_LIST_DIR}/compiler/snapshot.js
    ${CMAKE_CURRENT_LIST_DIR}/compiler/compile-pipeline.js
)

add_custom_command(
    OUTPUT  ${FACTORY_H}
    COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/runtime/bake_factory.js
    DEPENDS ${FACTORY_INPUTS}
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    COMMENT "Baking factory_snapshot.h from patches/meta-turing-machine.loupe"
    VERBATIM
)
add_custom_target(bake_factory DEPENDS ${FACTORY_H})

# ---- Main firmware target ----
# All kernel bodies are in runtime.c; kernels/*.c are no longer compiled separately.
add_executable(lens
    ${CMAKE_CURRENT_LIST_DIR}/runtime/main.cpp
    ${CMAKE_CURRENT_LIST_DIR}/runtime/sysex.cpp
    ${CMAKE_CURRENT_LIST_DIR}/runtime/runtime.c
    ${CMAKE_CURRENT_LIST_DIR}/runtime/midi.c
    ${CMAKE_CURRENT_LIST_DIR}/runtime/snapshot_apply.c
    ${CMAKE_CURRENT_LIST_DIR}/usb_descriptors.c
    ${FACTORY_H}
)

add_dependencies(lens bake_factory)

target_include_directories(lens PUBLIC
    ${CMAKE_CURRENT_LIST_DIR}/runtime
    ${CMAKE_CURRENT_LIST_DIR}/runtime/kernels
    ${CMAKE_CURRENT_LIST_DIR}          # ComputerCard.h, tusb_config.h
)

target_link_libraries(lens
    pico_unique_id
    pico_stdlib
    pico_multicore
    hardware_dma
    hardware_i2c
    hardware_pwm
    hardware_adc
    hardware_spi
    hardware_flash
    hardware_sync
    tinyusb_device
    tinyusb_board
)

# ---- USB: host + device stacks; role chosen at boot from the USB-C CC pins
# (keyboard plugged in -> host, computer -> device). ----
target_sources(lens PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/runtime/usb_host/usb_midi_host.c
    ${CMAKE_CURRENT_LIST_DIR}/runtime/usb_host/usb_midi_host_app_driver.c
)
target_include_directories(lens PUBLIC ${CMAKE_CURRENT_LIST_DIR}/runtime/usb_host)
target_link_libraries(lens tinyusb_host)

# Warn on double-promotion; block on wall/extra.
target_compile_options(lens PRIVATE
    -Wall -Wextra -Wdouble-promotion -Wfloat-conversion
)

# SPEC: flash-resident default; audio path RAM-pinned via __not_in_flash_func.
# Matches existing lens firmware strategy (see root CMakeLists.txt comments).
pico_set_binary_type(lens default)

# USB stdio breaks the normalisation probe cable-detect.
pico_enable_stdio_usb(lens 0)

# QSPI at sysclk/4 (required above 200 MHz; see root CMakeLists.txt).
pico_define_boot_stage2(lens_boot2 ${PICO_DEFAULT_BOOT_STAGE2_FILE})
target_compile_definitions(lens_boot2 PRIVATE PICO_FLASH_SPI_CLKDIV=4)
pico_set_boot_stage2(lens lens_boot2)

# Print RAM/flash usage after link.
target_link_options(lens PRIVATE -Wl,--print-memory-usage)

# XOSC startup delay guard (from root CMakeLists.txt).
target_compile_definitions(lens PRIVATE PICO_XOSC_STARTUP_DELAY_MULTIPLIER=64)

# Perf probe: per-sample cycle ring + per-slot counters. Default OFF (release).
# Enable with: cmake -B build -DLENS_PERF_PROBE=ON
option(LENS_PERF_PROBE "Compile in perf profiler; reduces audio torus to 64 KB" OFF)
target_compile_definitions(lens PRIVATE LENS_PERF_PROBE=$<BOOL:${LENS_PERF_PROBE}>)
message(STATUS "lens LENS_PERF_PROBE: ${LENS_PERF_PROBE}")

# The full card is always built (dual-core + USB + apply); no stage gates.

# Bake short git sha (lower 32 bits) into the firmware so CMD_DIAG can report
# the build identity. Dirty trees get top bit set as a warning flag.
execute_process(
    COMMAND git rev-parse --short=8 HEAD
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE LENS_GIT_SHA OUTPUT_STRIP_TRAILING_WHITESPACE)
execute_process(
    COMMAND git diff --quiet
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    RESULT_VARIABLE LENS_GIT_DIRTY)
if(NOT LENS_GIT_SHA)
    set(LENS_GIT_SHA "00000000")
endif()
if(LENS_GIT_DIRTY)
    set(LENS_BUILD_HASH_DEF "0x${LENS_GIT_SHA}u | 0x80000000u")
else()
    set(LENS_BUILD_HASH_DEF "0x${LENS_GIT_SHA}u")
endif()
target_compile_definitions(lens PRIVATE LENS_BUILD_HASH=${LENS_BUILD_HASH_DEF})
message(STATUS "lens build hash: ${LENS_BUILD_HASH_DEF}")

pico_add_extra_outputs(lens)

# Copy UF2 to repo root as lens.uf2 for easy flashing.
add_custom_command(TARGET lens POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE_DIR:lens>/lens.uf2"
        "${CMAKE_CURRENT_LIST_DIR}/lens.uf2"
    COMMENT "Copying lens.uf2 to repo root as lens.uf2"
)
