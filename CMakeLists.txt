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
set(PICO_BOARD pico CACHE STRING "Board type")

cmake_minimum_required(VERSION 3.13)
include(pico_sdk_import.cmake)
project(lens C CXX ASM)
set(CMAKE_CXX_STANDARD 17)
pico_sdk_init()

add_executable(lens
    main.cpp
    usb_descriptors.c
    usb_core1.cpp
    lens_sysex.cpp
)

target_include_directories(lens PUBLIC ${CMAKE_CURRENT_LIST_DIR})

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

target_compile_options(lens PRIVATE -Wdouble-promotion -Wfloat-conversion -Wall -Wextra)
target_link_options(lens PRIVATE -Wl,--print-memory-usage)
target_compile_definitions(lens PRIVATE PICO_XOSC_STARTUP_DELAY_MULTIPLIER=64)
# Run from flash (XIP), not copy_to_ram. The audio ISR (Lens::ProcessSample) is
# pinned to RAM with __not_in_flash_func so it never stalls on a flash cache miss;
# everything else (USB, SysEx, save/load, factory init) stays in flash. This frees
# ~76 KB of code RAM for the sample torus. This is what the sampling cards (Sheep,
# Grains, Glitch) do; copy_to_ram is for the small synth/sequencer cards that fit.
pico_set_binary_type(lens default)
pico_enable_stdio_usb(lens 0)   # USB stdio interferes with the normalisation probe

# Flash QSPI at sysclk/4, not the pico board default of /2. The default put the
# flash at 100 MHz through the program-card edge connector (at the very edge of a
# W25Q080's rating, and third-party cards fit whatever flash they like); /4 is
# near-free insurance since the whole audio path is RAM-pinned (only boot and cold
# paths slow down) and is required before running sysclk above 200 MHz.
pico_define_boot_stage2(lens_boot2 ${PICO_DEFAULT_BOOT_STAGE2_FILE})
target_compile_definitions(lens_boot2 PRIVATE PICO_FLASH_SPI_CLKDIV=4)
pico_set_boot_stage2(lens lens_boot2)

pico_add_extra_outputs(lens)

# Copy the freshly-built UF2 up to the repo root so it tracks alongside
# the source and is downloadable from GitHub without a release.
add_custom_command(TARGET lens POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE_DIR:lens>/lens.uf2"
        "${CMAKE_CURRENT_LIST_DIR}/lens.uf2"
    COMMENT "Copying lens.uf2 to repo root")
