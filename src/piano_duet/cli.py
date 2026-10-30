import argparse


def main():
    parser = argparse.ArgumentParser(description="A microphone piano duet, entirely on your Mac")
    parser.add_argument("command", nargs="?", choices=["run", "setup", "benchmark"], default="run")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Reload the server and browser when source files change",
    )
    args = parser.parse_args()
    if args.reload and args.command != "run":
        parser.error("--reload is only available when running the app")
    if args.command == "setup":
        from piano_duet.assets import main as setup

        setup()
    elif args.command == "benchmark":
        from piano_duet.benchmark import main as benchmark

        benchmark()
    else:
        from piano_duet.server import main as serve

        serve(args.port, not args.no_browser, reload=args.reload)


if __name__ == "__main__":
    main()
